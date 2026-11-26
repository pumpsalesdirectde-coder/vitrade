// Фоновая работа: между счетами обслуживает HTTP; новый проход — через секунду после предыдущего.
import { setImmediate as yieldToIO } from "node:timers/promises";
import { getValue, setValue, transaction, updateAccount, listAccounts } from "./db.js";
import { advance, applyFunding } from "./engine/engine.js";
import { bill, blockedUsers } from "./wallet.js";
import { collectAcceleration, collectFunding, collectMarket, collectSignal, collectStage } from "./market/bybit.js";

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

/** Index once: most due settlements belong to symbols never held by any account. */
export function pendingFunding(due, funding, accounts) {
  const known = new Set(funding.map(f => `${f.symbol}:${f.at}`));
  const bySymbol = new Map();
  for (const a of accounts) for (const c of a.cycles) {
    let cycles = bySymbol.get(c.symbol);
    if (!cycles) bySymbol.set(c.symbol, cycles = []);
    cycles.push(c);
  }
  return due.filter(f => !known.has(`${f.symbol}:${f.at}`)
    && bySymbol.get(f.symbol)?.some(c => c.openedAt < f.at && (c.closedAt === null || c.closedAt >= f.at)));
}

function accountContext(db, now) {
  const quotes = getValue(db, "market:quotes", {});
  const due = recordSettlements(db, now, Object.values(quotes));
  const funding = getValue(db, "market:funding", []);
  const funded = new Set(funding.map((f) => `${f.symbol}:${f.at}`));
  const missing = due.filter((f) => !funded.has(`${f.symbol}:${f.at}`));
  let blocked = new Set();
  try {
    blocked = blockedUsers(db);
  } catch { /* таблицы кошелька ещё нет — без блокировок */ }
  return { quotes, funding, missing, blocked };
}

function* accountSteps(db, time, isStopped = () => false) {
  if (isStopped()) return;
  const live = typeof time === "function";
  const clock = live ? time : () => time;
  const fixedContext = live ? null : accountContext(db, time);
  let processed = 0;
  for (const { id } of db.prepare("SELECT id FROM accounts").all()) {
    if (isStopped()) return;
    // A command/quote may arrive during the yield. Never backdate its fill to the pass start.
    const now = clock();
    const { quotes, funding, missing, blocked } = fixedContext || accountContext(db, now);
    transaction(db, () => {
      const row = db.prepare("SELECT state, revision FROM accounts WHERE id=?").get(id);
      if (!row) return;
      const a = JSON.parse(row.state);
      if (a.archived) return;
      for (const f of funding) applyFunding(a, f);
      a.fundingGaps = missing
        .filter((f) => holds(a, f.symbol, f.at))
        .map((f) => `${f.symbol}:${f.at}`);
      a.walletBlocked = blocked.has(a.ownerId);
      advance(a, quotes, now);
      updateAccount(db, a, row.revision);
      processed++;
    });
    // The transaction is committed before yielding: commands can safely update the next account.
    yield;
  }
  if (isStopped()) return;
  setValue(db, "worker:health", { at: clock(), processed, status: "running" });
}

/** Synchronous entry point retained for deterministic tests and replay. */
export function tickAccounts(db, now) {
  for (const _ of accountSteps(db, now)) { /* drain all transactions */ }
}

/** Never hold a transaction across an await or process all accounts in one blocking callback. */
export async function tickAccountsCooperatively(db, clock = Date.now, isStopped = () => false) {
  for (const _ of accountSteps(db, clock, isStopped)) await yieldToIO();
}

export async function refreshMarket(db, fetcher, now = Date.now(), paperCycles = () => []) {
  const cache = getValue(db, "market:cache", {});
  const accounts = listAccounts(db, {snapshots: false});
  const paper = paperCycles();
  const held = [...new Set([
    ...accounts.flatMap((a) => a.cycles.filter((c) => c.status !== "CLOSED").map((c) => c.symbol)),
    ...paper.filter((c) => c.closedAt === null).map((c) => c.symbol),
  ])];
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
  const protectedHeld = [...new Set(accounts.flatMap((a) => a.cycles
    .filter((c) => c.status === "OPEN" && c.direction === "SHORT" && c.config.accelerationStopOn)
    .map((c) => c.symbol)))];
  await batch(protectedHeld.filter((s) => current.quotes?.[s] && current.quotes[s].accelerationAt !== five),
    async (s) => merge(s, await collectAcceleration(fetcher, s, now)));
  await batch((current.universe || []).filter((s) => (current.quotes?.[s]?.signalAt || 0) < five),
    async (s) => merge(s, await collectSignal(fetcher, s, now)));
  const hour = Math.floor(now / 36e5) * 36e5;
  await batch((current.stageWatch || []).filter((s) => current.quotes?.[s] && (current.quotes[s].stageCheckedAt || 0) < hour),
    async (s) => merge(s, await collectStage(fetcher, s, now)));
  if (current.quotes) setValue(db, "market:cache", current);
  const due = getValue(db, "market:fundingDue", []);
  const latestPaper = paperCycles();
  for (const f of pendingFunding(due, funding, latestPaper.length ? [...accounts, { cycles: latestPaper }] : accounts)) {
    try {
      funding.push(await collectFunding(fetcher, f.symbol, f.at));
      setValue(db, "market:funding", funding.filter((x) => now - x.at < 7 * 864e5));
    } catch {
      /* ставка ещё не опубликована — повторим на следующем круге */
    }
  }
}

export function startRunner(db, fetcher, { offline = false, paperCycles } = {}) {
  let collecting = false;
  let billedAt = 0;
  let stopped = false;
  let t1;
  const tick = async () => {
    if (stopped) return;
    try {
      await tickAccountsCooperatively(db, Date.now, () => stopped);
      if (stopped) return;
      if (Date.now() - billedAt > 1e4) {
        billedAt = Date.now();
        try {
          bill(db);
        } catch { /* кошелёк ещё не создан */ }
      }
    } catch (e) {
      if (!stopped) setValue(db, "worker:health", { at: Date.now(), status: "error", message: e.message });
    } finally {
      // setInterval queues work continuously when one pass already takes more than a second.
      // Leave a full rest interval after completion, and never overlap account passes.
      if (!stopped) t1 = setTimeout(() => void tick(), 1e3);
    }
  };
  const collect = async () => {
    if (stopped || collecting) return;
    if (offline) {
      setValue(db, "market:health", { at: Date.now(), status: "disabled", message: "Рынок отключён (offline)" });
      return;
    }
    collecting = true;
    try {
      await refreshMarket(db, fetcher, Date.now(), paperCycles);
    } finally {
      collecting = false;
    }
  };
  t1 = setTimeout(() => void tick(), 0);
  void collect();
  const t2 = setInterval(() => void collect(), 15e3);
  return () => {
    stopped = true;
    clearTimeout(t1);
    clearInterval(t2);
  };
}
