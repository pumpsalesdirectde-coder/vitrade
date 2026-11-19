import { setImmediate as yieldToIO } from "node:timers/promises";
import { getValue, transaction } from "../db.js";
import { advancePaper, configurePaper, createPaperState, paperView } from "./strategy.js";
import { fetchPaperCandles, FIVE_MINUTES, hourlyPaperUniverse } from "./market.js";

const FUNDING_WINDOW = 3 * 86_400_000;
const POLL_MS = 2_000;
const KLINE_CONCURRENCY = 4;
const KLINE_ATTEMPTS = 2;
const KLINE_RETRY_MS = 4_000;
const MAX_TRACKED_CANDLES = 60;
const WARMUP = 120;

const positionList = state => Object.values(state.positions);

function parseCommand(body) {
  const { enabled, direction, regime } = body ?? {};
  if (typeof enabled !== "boolean") throw Error("Укажите состояние режима PAPER");
  if (direction !== undefined && !["LONG", "SHORT"].includes(direction)) throw Error("Выберите LONG или SHORT");
  if (regime !== undefined && !["impulse", "quiet"].includes(regime)) throw Error("Выберите тип диапазона");
  return { enabled, direction, regime };
}

export function createRangePaperService(db, { fetcher, offline = false, clock = Date.now } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS range_paper (
    owner_id TEXT PRIMARY KEY, state TEXT NOT NULL, enabled INTEGER NOT NULL,
    open_positions INTEGER NOT NULL, last_close_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS range_paper_active ON range_paper(owner_id)
    WHERE enabled=1 OR open_positions>0;
  CREATE INDEX IF NOT EXISTS range_paper_recent_close ON range_paper(last_close_at)
    WHERE last_close_at>0;`);
  const readRow = db.prepare("SELECT state FROM range_paper WHERE owner_id=?");
  const writeRow = db.prepare(`INSERT INTO range_paper VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(owner_id) DO UPDATE SET state=excluded.state, enabled=excluded.enabled,
    open_positions=excluded.open_positions, last_close_at=excluded.last_close_at`);
  const interested = db.prepare(`SELECT owner_id, enabled, open_positions FROM range_paper
    WHERE enabled=1 OR open_positions>0 OR (last_close_at>0 AND last_close_at>=?)`);
  const cycleRows = db.prepare(`SELECT state FROM range_paper
    WHERE open_positions>0 OR (last_close_at>0 AND last_close_at>=?)`);

  let universe = null;
  let stopWorker;
  let marketError = false;
  let requesting = null;
  let generation = 0;
  const candles = new Map();
  const attempts = new Map();
  const empty = new Set();

  function write(ownerId, state) {
    const lastClose = state.trades.at(-1)?.closedAt ?? 0;
    writeRow.run(ownerId, JSON.stringify(state), Number(state.enabled), positionList(state).length, lastClose);
  }

  function view(state) {
    const now = clock();
    const close = Math.floor(now / FIVE_MINUTES) * FIVE_MINUTES;
    const selected = universe?.symbols ?? empty;
    const ready = [...selected].filter(symbol => {
      const bars = candles.get(symbol);
      return bars?.at(-1)?.t === close - FIVE_MINUTES && bars.at(-WARMUP)?.t === close - WARMUP * FIVE_MINUTES;
    }).length;
    const summary = paperView(state);
    return {
      ...summary,
      status: state.enabled && !offline
        ? summary.marketAt > 0 && now - summary.marketAt > 15_000 ? "stale" : ready ? summary.status : "warming"
        : summary.status,
      marketStatus: offline ? "offline" : marketError ? "unavailable" : ready ? "ready" : "waiting",
      scanCount: selected.size, candlesReady: ready,
    };
  }

  function read(ownerId) {
    const row = readRow.get(ownerId);
    return view(row ? JSON.parse(row.state) : createPaperState());
  }

  function configure(ownerId, body) {
    const command = parseCommand(body);
    return transaction(db, () => {
      const row = readRow.get(ownerId);
      const state = row ? JSON.parse(row.state) : createPaperState();
      configurePaper(state, command, clock());
      if (row || command.enabled) write(ownerId, state);
      return view(state);
    });
  }

  function cycles() {
    const since = clock() - FUNDING_WINDOW;
    const result = [];
    for (const {state: packed} of cycleRows.all(since)) {
      const state = JSON.parse(packed);
      for (const {symbol, openedAt} of positionList(state)) result.push({symbol, openedAt, closedAt: null});
      for (const {symbol, openedAt, closedAt} of state.trades) {
        if (closedAt >= since) result.push({symbol, openedAt, closedAt});
      }
    }
    return result;
  }

  function clearMarket() {
    generation++;
    universe = null;
    requesting = null;
    candles.clear();
    attempts.clear();
    marketError = false;
  }

  function candleSymbols(users) {
    const held = new Set();
    const tracked = new Set();
    for (const {owner_id: id, enabled, open_positions: open} of users) {
      if (!enabled && !open) continue;
      const {state: packed} = readRow.get(id);
      const state = JSON.parse(packed);
      for (const {symbol} of positionList(state)) held.add(symbol);
      for (const [symbol, watch] of Object.entries(state.symbols)) if (watch.range) tracked.add(symbol);
    }
    const essential = new Set([...held, ...(universe?.symbols ?? [])]);
    const spare = Math.max(0, MAX_TRACKED_CANDLES - essential.size);
    const extra = [...tracked].filter(symbol => !essential.has(symbol)).slice(0, spare);
    return [...essential, ...extra];
  }

  function requestCandles(symbols, now) {
    if (!fetcher || requesting || !symbols.length) return;
    const slot = Math.floor(now / FIVE_MINUTES) * FIVE_MINUTES;
    const wanted = new Set(symbols);
    for (const symbol of attempts.keys()) if (!wanted.has(symbol)) attempts.delete(symbol);
    for (const symbol of candles.keys()) if (!wanted.has(symbol)) candles.delete(symbol);
    const batch = symbols.filter(symbol => {
      if (candles.get(symbol)?.at(-1)?.t === slot - FIVE_MINUTES) return false;
      const previous = attempts.get(symbol);
      return previous?.slot !== slot || (previous.count < KLINE_ATTEMPTS && now >= previous.nextAt);
    });
    if (!batch.length) return;

    const token = generation;
    requesting = (async () => {
      let success = false;
      for (let i = 0; i < batch.length && token === generation; i += KLINE_CONCURRENCY) {
        await Promise.all(batch.slice(i, i + KLINE_CONCURRENCY).map(async symbol => {
          const previous = attempts.get(symbol);
          const startedAt = clock();
          attempts.set(symbol, { slot, count: previous?.slot === slot ? previous.count + 1 : 1, nextAt: startedAt + KLINE_RETRY_MS });
          try {
            const bars = await fetchPaperCandles(fetcher, symbol, now);
            if (token !== generation) return;
            const prior = candles.get(symbol);
            if (bars.length && (!prior || bars.at(-1).t >= prior.at(-1).t)) candles.set(symbol, bars);
            if (bars.at(-1)?.t === slot - FIVE_MINUTES) success = true;
          } catch { /* Retry at the same boundary within the shared request budget. */ }
        }));
      }
      if (token === generation) {
        requesting = null;
        marketError = !success && ![...candles.values()].some(bars => bars.at(-1)?.t === slot - FIVE_MINUTES);
      }
    })();
  }

  function start() {
    if (stopWorker) return stopWorker;
    if (offline) return () => {};
    let stopped = false;
    let timer;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      clearMarket();
      stopWorker = null;
    };
    stopWorker = stop;

    async function tick() {
      if (stopped) return;
      try {
        const now = clock();
        const users = interested.all(now - FUNDING_WINDOW);
        if (!users.length) {
          if (universe || requesting || candles.size) clearMarket();
          return;
        }
        const enabled = users.some(row => row.enabled);
        const watching = enabled || users.some(row => row.open_positions);
        const quotes = watching ? getValue(db, "market:quotes", {}) : {};
        const funding = getValue(db, "market:funding", []);
        const fundingDue = getValue(db, "market:fundingDue", []);
        if (enabled) {
          universe = hourlyPaperUniverse(getValue(db, "market:cache", {}), quotes, now, universe);
          requestCandles(candleSymbols(users), now);
        } else if (universe || requesting || candles.size) clearMarket();
        const candidates = universe?.symbols ?? empty;

        for (const { owner_id: id } of users) {
          if (stopped) break;
          transaction(db, () => {
            const row = readRow.get(id);
            if (!row) return;
            const state = JSON.parse(row.state);
            if (!state.enabled && !positionList(state).length && !funding.length && !fundingDue.length) return;
            if (advancePaper(state, { now: clock(), quotes, universe: candidates, candles, funding, fundingDue })) write(id, state);
          });
          await yieldToIO();
        }
      } catch (error) {
        marketError = true;
        console.error("PAPER range worker:", error.message);
      } finally {
        if (!stopped) {
          timer = setTimeout(() => void tick(), POLL_MS);
          timer.unref?.();
        }
      }
    }
    void tick();
    return stop;
  }

  return { read, configure, cycles, start };
}
