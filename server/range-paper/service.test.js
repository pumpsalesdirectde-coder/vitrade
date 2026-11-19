import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as yieldToIO } from "node:timers/promises";
import { openDatabase, setValue } from "../db.js";
import { createRangePaperService } from "./service.js";
import { fetchPaperCandles, hourlyPaperUniverse } from "./market.js";

const FIVE = 300_000;
const HOUR = 3_600_000;
const H = Date.UTC(2026, 0, 1, 12);
const NOW = H + 5_000;
const cached = { universe: ["BTCUSDT", "ETHUSDT", "XRPUSDT"] };
const quote = (symbol, turnover, at = NOW) => ({ symbol, turnover: String(turnover), at, bid: "1", ask: "1.01", mark: "1", last: "1" });
const quotes = (...rows) => Object.fromEntries(rows.map((row) => [row.symbol, row]));
const fakeRows = (list, time = NOW) => ({ ok: true, json: async () => ({ retCode: 0, time, result: { list } }) });
const kline = (at, o = 2, h = 3, l = 1, c = 2, v = 10, q = 20) => [at, o, h, l, c, v, q].map(String);

test("default PAPER is off, unpersisted, and idle on a fresh market", async () => {
  const db = openDatabase(":memory:");
  let calls = 0;
  const service = createRangePaperService(db, { fetcher: async () => { calls++; return fakeRows([]); }, clock: () => NOW });
  setValue(db, "market:cache", cached);
  setValue(db, "market:quotes", quotes(quote("BTCUSDT", 20e6)));
  const stop = service.start();
  try {
    const view = service.read("alice");
    assert.equal(view.enabled, false);
    assert.equal(view.initial, 10000);
    assert.equal(view.budget, 500);
    assert.equal(view.leverage, 5);
    assert.deepEqual(service.cycles(), []);
    await yieldToIO();
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM range_paper").get().n, 0);
    assert.equal(calls, 0);
  } finally { stop(); db.close(); }
});

test("explicit opt-in persists independently of existing accounts and other users", () => {
  const db = openDatabase(":memory:");
  try {
    const service = createRangePaperService(db, { clock: () => NOW });
    assert.throws(() => service.configure("alice", { enabled: "true" }));
    assert.throws(() => service.configure("alice", { enabled: true, direction: "ANY" }));
    assert.throws(() => service.configure("alice", { enabled: true, regime: "unknown" }));
    service.configure("alice", { enabled: true, direction: "SHORT", regime: "quiet" });
    const restarted = createRangePaperService(db, { clock: () => NOW });
    assert.equal(restarted.read("alice").direction, "SHORT");
    assert.equal(restarted.read("alice").regime, "quiet");
    assert.equal(restarted.read("alice").enabled, true);
    assert.equal(restarted.read("bob").enabled, false);
    assert.equal(restarted.read("bob").direction, "LONG");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM accounts").get().n, 0);
    assert.equal(restarted.configure("alice", { enabled: false }).enabled, false);
    assert.equal(restarted.read("alice").direction, "SHORT");
  } finally { db.close(); }
});

test("closed candle loader keeps real gaps and drops open, inactive, and broken rows", async () => {
  const seen = [];
  const rows = [kline(H), kline(H - FIVE), kline(H - FIVE * 2, 2, 1, 1, 2), kline(H - FIVE * 3, 2, 3, 1, 2, 0, 20), kline(H - FIVE * 4)];
  const actual = await fetchPaperCandles(async (url, options) => {
    seen.push([new URL(url), options]);
    return fakeRows(rows);
  }, "BTCUSDT", NOW);
  assert.deepEqual(actual, [H - FIVE * 4, H - FIVE].map(t => ({ t, o: 2, h: 3, l: 1, c: 2, qv: 20, trades: 1 })));
  assert.equal(seen[0][0].origin, "https://api.bybit.com");
  assert.equal(seen[0][0].pathname, "/v5/market/kline");
  assert.equal(seen[0][0].searchParams.get("interval"), "5");
  assert.ok(seen[0][1].signal instanceof AbortSignal);
});

test("exchange time must confirm a close even if the local clock already crossed it", async () => {
  const rows = [kline(H - FIVE), kline(H - FIVE * 2)];
  const candles = await fetchPaperCandles(async () => fakeRows(rows, H - 1), "BTCUSDT", H + 1);
  assert.deepEqual(candles.map(bar => bar.t), [H - FIVE * 2]);
});

test("universe freezes only from fresh quotes of the current UTC hour", () => {
  const first = hourlyPaperUniverse(cached, quotes(quote("BTCUSDT", 20e6), quote("ETHUSDT", 15e6), quote("XRPUSDT", 9e6)), NOW);
  assert.deepEqual([...first.symbols], ["BTCUSDT", "ETHUSDT"]);
  const changed = hourlyPaperUniverse(cached, quotes(quote("XRPUSDT", 25e6)), NOW + 1, first);
  assert.deepEqual([...changed.symbols], ["BTCUSDT", "ETHUSDT"]);
  const newHour = H + HOUR;
  assert.equal(hourlyPaperUniverse(cached, quotes(quote("XRPUSDT", 25e6, newHour - 5_000)), newHour + 1, first), null);
  assert.deepEqual([...hourlyPaperUniverse(cached, quotes(quote("XRPUSDT", 25e6, newHour)), newHour + 1, first).symbols], ["XRPUSDT"]);
});

test("enabled users share one bounded candle request per symbol", { timeout: 3_000 }, async () => {
  const db = openDatabase(":memory:");
  const symbols = ["AUSDT", "BUSDT", "CUSDT", "DUSDT", "EUSDT", "FUSDT"];
  const market = quotes(...symbols.map(symbol => quote(symbol, 20e6)));
  setValue(db, "market:cache", { universe: symbols });
  setValue(db, "market:quotes", market);
  const rows = Array.from({length: 120}, (_, i) => kline(H - (i + 1) * FIVE));
  const fetched = [];
  let pending = 0;
  let peak = 0;
  let complete;
  const done = new Promise(resolve => { complete = resolve; });
  const service = createRangePaperService(db, { clock: () => NOW, fetcher: async url => {
    pending++;
    peak = Math.max(peak, pending);
    await yieldToIO();
    pending--;
    fetched.push(new URL(url).searchParams.get("symbol"));
    if (fetched.length === symbols.length) complete();
    return fakeRows(rows);
  }});
  service.configure("alice", {enabled: true, direction: "LONG"});
  service.configure("bob", {enabled: true, direction: "SHORT"});
  const stop = service.start();
  try {
    await done;
    await yieldToIO();
    assert.deepEqual(fetched, symbols);
    assert.ok(peak <= 4);
    assert.equal(service.read("alice").candlesReady, symbols.length);
    assert.equal(service.read("bob").candlesReady, symbols.length);
  } finally { stop(); db.close(); }
});
