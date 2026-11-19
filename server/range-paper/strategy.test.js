import test from "node:test";
import assert from "node:assert/strict";
import { advancePaper, configurePaper, createPaperState, paperView } from "./strategy.js";

const FIVE = 300_000;
const START = Date.UTC(2024, 0, 1);
const at = (index) => START + index * FIVE;
const SYMBOL = "TESTUSDT";

function candle(index, c, o = c) {
  return { t: at(index), o, h: Math.max(o, c) + 0.15, l: Math.min(o, c) - 0.15, c, qv: 50_000, trades: 20 };
}

function fixture(withSwing) {
  const pattern = [100, 100, 101, 102, 102, 102, 101, 100];
  const warmup = Array.from({ length: 120 }, (_, i) => candle(i - 120, pattern[Math.floor(i / 3) % 8]));
  const continuation = withSwing
    ? [101.3, 101.4, 101.4, 100.2, 100.1, 100.05, 100.25, 100.3, 100.35, 101.6, 101.4, 101.1]
    : [101.1, 100.2, 100, 100.15, 100.3, 100.35, 101.6, 101.4, 101.1];
  const closes = [100, 100, 100, 100.2, 100.3, 100.35, 101.6, 101.4, 101.2, ...continuation, ...Array(7).fill(103)];
  const bars = closes.map((c, i) => candle(i, c, i === 6 || i === (withSwing ? 18 : 15) ? 100.35 : c));
  return { bars, snapshot: [...warmup, ...bars] };
}

function enabled(direction = "LONG", regime = "quiet") {
  const paper = createPaperState({ direction, regime });
  configurePaper(paper, { enabled: true }, at(0) - 1);
  return paper;
}

function input(data, i, { now = at(i), quoteAt = now, price = data.bars[i].o, symbols = [SYMBOL], ...overrides } = {}) {
  return {
    now,
    candles: new Map(symbols.map((symbol) => [symbol, data.snapshot])),
    universe: new Set(symbols),
    quotes: Object.fromEntries(symbols.map((symbol) => [symbol, { at: quoteAt, bid: price - 0.001, ask: price + 0.001, last: price, mark: price }])),
    ...overrides,
  };
}

function play(paper, data, through, start = 0) {
  for (let i = start; i <= through; i++) advancePaper(paper, input(data, i));
}

test("PAPER starts disabled and produces no history from an otherwise tradeable feed", () => {
  const paper = createPaperState({ regime: "quiet" });
  const data = fixture(true);
  const initial = paperView(paper);
  play(paper, data, 21);
  assert.deepEqual(paperView(paper), initial);
  assert.deepEqual([initial.status, initial.initial, initial.budget, initial.leverage, initial.cash], ["disabled", 10_000, 500, 5, 10_000]);
});

test("trade 2 requires a full later midpoint close and a separate near-edge touch", () => {
  const withSwing = enabled();
  const withoutSwing = enabled();
  play(withSwing, fixture(true), 21);
  play(withoutSwing, fixture(false), 18);
  assert.deepEqual(paperView(withoutSwing).trades.map(({ turn }) => turn), [1]);
  assert.deepEqual(paperView(withSwing).trades.map(({ turn, openedAt, closedAt, reason }) => [turn, openedAt, closedAt, reason]), [
    [1, at(6), at(7), "TAKE_PROFIT"], [2, at(18), at(19), "TAKE_PROFIT"],
  ]);
  assert.equal(withSwing.trades[1].freshSwingAt, at(12));
});

test("a complete close may wait for a newer quote without filling at the old price", () => {
  const paper = enabled();
  const data = fixture();
  play(paper, data, 5);
  advancePaper(paper, input(data, 6, { quoteAt: at(6) - 1 }));
  assert.equal(paperView(paper).positions.length, 0);
  advancePaper(paper, input(data, 6, { now: at(6) + 5_000 }));
  assert.equal(paperView(paper).positions[0].openedAt, at(6) + 5_000);
});

test("the latest signal expires and the strategy never backfills an old trade", () => {
  const paper = enabled();
  const data = fixture();
  play(paper, data, 5);
  advancePaper(paper, input(data, 6, { now: at(6) + 31_000 }));
  assert.equal(paperView(paper).positions.length, 0);
  assert.equal(paperView(paper).trades.length, 0);
});

test("a missing component of a 15-minute candle cannot confirm a fill using a later bar", () => {
  const paper = enabled();
  const data = fixture();
  play(paper, data, 5);
  const incomplete = data.snapshot.filter((bar) => bar.t !== at(5));
  advancePaper(paper, input(data, 6, { candles: new Map([[SYMBOL, incomplete]]) }));
  assert.equal(paperView(paper).positions.length, 0);
});

test("a missing live candle invalidates a held range, which exits at the next fresh quote", () => {
  const paper = enabled();
  const data = fixture();
  play(paper, data, 6);
  advancePaper(paper, input(data, 7, { now: at(7) + 31_000, quoteAt: at(7), candles: new Map() }));
  assert.equal(paperView(paper).positions[0].pendingExit, "DATA_GAP");
  advancePaper(paper, input(data, 7, { now: at(7) + 35_000, candles: new Map() }));
  assert.equal(paperView(paper).trades[0].reason, "DATA_GAP");
  assert.equal(paperView(paper).trades[0].closedAt, at(7) + 35_000);
});

test("the short direction mirrors the range and buys back below its entry", () => {
  const paper = enabled("SHORT");
  const source = fixture(true);
  const reflect = (row) => ({ ...row, o: 201 - row.o, h: 201 - row.l, l: 201 - row.h, c: 201 - row.c });
  play(paper, { bars: source.bars.map(reflect), snapshot: source.snapshot.map(reflect) }, 7);
  const [trade] = paperView(paper).trades;
  assert.equal(trade.direction, "SHORT");
  assert.equal(trade.reason, "TAKE_PROFIT");
  assert.ok(trade.exitPrice < trade.entryPrice && trade.net > 0);
});

test("simultaneous signals share one margin budget and fill in symbol order", () => {
  const paper = enabled();
  const data = fixture();
  const symbols = ["ZUSDT", "AUSDT"];
  for (let i = 0; i < 7; i++) advancePaper(paper, input(data, i, { symbols }));
  const view = paperView(paper);
  assert.equal(view.positions[0].symbol, "AUSDT");
  assert.ok(view.usedMargin <= 500 + 1e-9);
  assert.ok(view.positions.reduce((sum, position) => sum + position.notional, 0) <= 2_500 + 1e-9);
  assert.ok(view.positions.every((position) => position.plannedRisk <= 25 + 1e-9));
});

test("disabling waits for a valid quote and drains without creating a new entry", () => {
  const paper = enabled();
  const data = fixture(true);
  play(paper, data, 6);
  configurePaper(paper, { enabled: false }, at(6) + 100);
  assert.equal(paperView(paper).status, "draining");
  advancePaper(paper, input(data, 6, { now: at(6) + 1_000, quoteAt: at(6) }));
  assert.equal(paperView(paper).positions.length, 1);
  assert.throws(() => configurePaper(paper, { enabled: true, direction: "SHORT" }, at(6) + 1_010));
  advancePaper(paper, input(data, 6, { now: at(6) + 2_000 }));
  assert.equal(paperView(paper).status, "disabled");
  assert.equal(paperView(paper).trades[0].reason, "DISABLED");
});

test("late funding adjusts original closed trade and cash exactly once", () => {
  const paper = enabled();
  const data = fixture();
  play(paper, data, 7);
  const original = paperView(paper);
  const f = { symbol: SYMBOL, at: at(6) + 1_000, rate: 0.001, mark: 100 };
  const fundingDue = [{ symbol: f.symbol, at: f.at }];
  advancePaper(paper, input(data, 8, { fundingDue }));
  assert.equal(paperView(paper).fundingPending, 1);
  advancePaper(paper, input(data, 8, { fundingDue, funding: [f, f] }));
  const end = paperView(paper);
  assert.equal(end.fundingPending, 0);
  assert.ok(Math.abs(end.cash - original.cash + original.trades[0].qty * 0.1) < 1e-8);
  assert.ok(Math.abs(end.trades[0].net - original.trades[0].net + original.trades[0].qty * 0.1) < 1e-8);
  assert.equal(advancePaper(paper, input(data, 8, { fundingDue, funding: [f] })), false);
});

test("a mark liquidation takes precedence when it and the traded stop are both breached", () => {
  const paper = enabled();
  const data = fixture();
  play(paper, data, 6);
  advancePaper(paper, input(data, 6, { now: at(6) + 400, price: 75 }));
  const [trade] = paperView(paper).trades;
  assert.equal(trade.reason, "LIQUIDATION");
  assert.equal(trade.closedAt, at(6) + 400);
  assert.ok(trade.net < -25);
});

test("an entry whose fresh mark is already beyond its liquidation threshold leaves cash intact", () => {
  const paper = enabled();
  const data = fixture();
  play(paper, data, 5);
  const confirmation = input(data, 6);
  confirmation.quotes[SYMBOL].mark = 75;
  advancePaper(paper, confirmation);
  const view = paperView(paper);
  assert.equal(view.positions.length, 0);
  assert.equal(view.trades.length, 0);
  assert.equal(view.cash, 10_000);
});
