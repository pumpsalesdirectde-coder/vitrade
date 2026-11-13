// Фоновая работа: раз в секунду продвигает счета, раз в 5 секунд обновляет рынок.
import { getValue, setValue, transaction } from "./db.js";
import { advance, applyFunding } from "./engine/engine.js";
import { collectFunding, collectMarket, collectSignal, collectStage } from "./market/bybit.js";

/** Фиксирует прошедшие моменты расчёта фандинга по монетам, чтобы потом подтянуть ставку. */
function recordSettlements(db, now, observations = []) {
  return transaction(db, () => {
    const schedules = getValue(db, "market:schedules", {});
    const due = getValue(db, "market:fundingDue", []);
    const cross = (symbol, s) => {
      let n = 0;
      while (s.next > 0 && s.next <= now && n++ < 1e4) {
        if (!due.some((f) => f.symbol === symbol && f.at === s.next)) due.push({ symbol, at: s.next });
        s.next += s.interval;
      }
    };
    for (const [symbol, s] of Object.entries(schedules)) cross(symbol, s);
    for (const q of observations) {
      if (!q.nextFundingAt || !Number.isFinite(q.nextFundingAt)) continue;
      const s = { next: q.nextFundingAt, interval: (q.intervalHours > 0 ? q.intervalHours : 8) * 36e5 };
      cross(q.symbol, s);
      schedules[q.symbol] = s;
    }
    // старше 3 суток держать незачем
    const keep = due.filter((f) => now - f.at < 3 * 864e5);
    setValue(db, "market:schedules", schedules);
    setValue(db, "market:fundingDue", keep);
    return keep;
  });
}

const holds = (a, symbol, at) =>
  a.cycles.some((c) => c.symbol === symbol && c.openedAt < at && (c.closedAt === null || c.closedAt >= at));

export function tickAccounts(db, now) {
  const quotes = getValue(db, "market:quotes", {});
  const due = recordSettlements(db, now, Object.values(quotes));
  const funding = getValue(db, "market:funding", []);
  let processed = 0;
  for (const { id } of db.prepare("SELECT id FROM accounts").all()) {
    transaction(db, () => {
      const row = db.prepare("SELECT state, revision FROM accounts WHERE id=?").get(id);
      const a = JSON.parse(row.state);
      if (a.archived) return;
      for (const f of funding) applyFunding(a, f);
      a.fundingGaps = due
        .filter((f) => holds(a, f.symbol, f.at) && !funding.some((x) => x.symbol === f.symbol && x.at === f.at))
        .map((f) => `${f.symbol}:${f.at}`);
      advance(a, quotes, now);
      db.prepare("UPDATE accounts SET state=?, revision=revision+1 WHERE id=? AND revision=?").run(JSON.stringify(a), id, row.revision);
      processed++;
    });
  }
  setValue(db, "worker:health", { at: now, processed, status: "running" });
}

export async function refreshMarket(db, fetcher, now = Date.now()) {
  const cache = getValue(db, "market:cache", {});
  const accounts = db.prepare("SELECT state FROM accounts").all().map((r) => JSON.parse(r.state));
  const held = [...new Set(accounts.flatMap((a) => a.cycles.filter((c) => c.status !== "CLOSED").map((c) => c.symbol)))];
  const funding = getValue(db, "market:funding", []);
  try {
    const result = await collectMarket(fetcher, now, cache, held);
    recordSettlements(db, now, Object.values(result.quotes));
    setValue(db, "market:quotes", result.quotes);
    setValue(db, "market:cache", result);
    setValue(db, "market:health", { at: Date.now(), status: "connected", symbols: Object.keys(result.quotes).length, provider: "Bybit" });
  } catch (e) {
    setValue(db, "market:health", { at: Date.now(), status: "unavailable", message: e.message });
  }
  const current = getValue(db, "market:cache", {});
  const merge = (symbol, patch) => {
    const live = getValue(db, "market:quotes", {});
    if (live[symbol]) {
      Object.assign(live[symbol], patch);
      setValue(db, "market:quotes", live);
    }
    if (current.quotes?.[symbol]) Object.assign(current.quotes[symbol], patch);
  };
  const batch = async (list, fn) => {
    for (let i = 0; i < list.length; i += 5) await Promise.all(list.slice(i, i + 5).map((s) => fn(s).catch(() => {})));
  };
  const five = Math.floor(now / 3e5) * 3e5;
  await batch((current.universe || []).filter((s) => (current.quotes?.[s]?.signalAt || 0) < five),
    async (s) => merge(s, await collectSignal(fetcher, s, now)));
  const hour = Math.floor(now / 36e5) * 36e5;
  await batch((current.stageWatch || []).filter((s) => current.quotes?.[s] && (current.quotes[s].stageCheckedAt || 0) < hour),
    async (s) => merge(s, await collectStage(fetcher, s, now)));
  if (current.quotes) setValue(db, "market:cache", current);
  const due = getValue(db, "market:fundingDue", []);
  for (const f of due.filter((x) => !funding.some((y) => y.symbol === x.symbol && y.at === x.at) && accounts.some((a) => holds(a, x.symbol, x.at)))) {
    try {
      funding.push(await collectFunding(fetcher, f.symbol, f.at));
      setValue(db, "market:funding", funding.filter((x) => now - x.at < 7 * 864e5));
    } catch {
      /* ставка ещё не опубликована — повторим на следующем круге */
    }
  }
}

export function startRunner(db, fetcher, { offline = false } = {}) {
  let collecting = false;
  const tick = () => {
    try {
      tickAccounts(db, Date.now());
    } catch (e) {
      setValue(db, "worker:health", { at: Date.now(), status: "error", message: e.message });
    }
  };
  const collect = async () => {
    if (collecting) return;
    if (offline) {
      setValue(db, "market:health", { at: Date.now(), status: "disabled", message: "Рынок отключён (offline)" });
      return;
    }
    collecting = true;
    try {
      await refreshMarket(db, fetcher);
    } finally {
      collecting = false;
    }
  };
  tick();
  void collect();
  const t1 = setInterval(tick, 1e3);
  const t2 = setInterval(() => void collect(), 5e3);
  return () => {
    clearInterval(t1);
    clearInterval(t2);
  };
}
