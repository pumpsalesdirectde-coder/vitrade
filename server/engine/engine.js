// Торговый движок бумажного счёта. Логика перенесена из VITrade 0.1.0 (domain/engine.ts,
// server engine.ts) вместе с доработками: мультистратегийный авто-режим и стадии памп-цикла.
import { randomUUID } from "node:crypto";
import {
  D, Decimal, str, add, sub, positive, unrealized, totalResult, executionPrice, expectedResult,
  reserved, free, liquidation, lr, breakEven,
} from "./accounting.js";
import { STRATEGY_KEYS, stageDirection } from "./signals.js";
import { FORK_DEFAULTS, normalizeFork, observeFork } from './fork.js';
import { advancePairs, tryOpenFork, requestPairClose, pairView } from './fork-lifecycle.js';

export const LIMITS = { accounts: 20, botsPerAccount: 20, steps: [1, 8], leverage: [1, 10] };

export const DEFAULT_CONFIG = {
  fork: FORK_DEFAULTS,
  name: "Авто-бот", symbol: "BTCUSDT", mode: "auto", direction: "SHORT", budget: "500", leverage: 5, steps: 8,
  spacingPct: "4.5", entryPct: "4.5", orderPcts: Array(8).fill("4.5"), tpPct: "1.25", slPct: "100", feeRate: "0.00055", slippageRate: "0.0002",
  marginAuto: true, marginCap: "100", exclusions: [],
  // подстраховка: после шага guardStep, если цена за guardMinutes после последней докупки ушла против позиции
  // на guardPct% и больше, бот перестаёт докупать и держит набранный объём
  guardOn: true, guardStep: 3, guardPct: "20", guardMinutes: 60,
  accelerationStopOn: false, accelerationStopPct: "10",
  stages: { RSI_SHORT: false, RSI_LONG: false, PUMP: false, EARLY: false, FLIP: false, DUMP: false, DUMP_ACCEL: false, CRASH: false },
};

export function newAccount(id, ownerId, name, source, now, exchange = "bybit", initial = "10000") {
  return {
    id, ownerId, name, source, exchange, createdAt: now, initial, cash: initial, archived: false,
    bots: [], cycles: [], fills: [],
    events: [{ id: randomUUID(), at: now, type: "CAPITAL", message: "Начальный виртуальный капитал", amount: initial }],
    fundingIds: [], fundingGaps: [], snapshots: [{ at: now, equity: initial }], peakEquity: initial, maxDrawdown: "0",
    scenarioStep: 0, stopBlacklist: [],
  };
}

export function event(a, type, message, now, b, c, amount) {
  a.events.push({ id: randomUUID(), at: now, type, message, botId: b?.id, cycleId: c?.id, amount });
}

const fresh = (q, a, now) => !!q && q.source === a.source && positive(q.mark) && q.at <= now + 1e3 && now - q.at <= 15e3;

function increase(a, b, c, q, amount, grid, now, exactQuantity) {
  const p = executionPrice(c, q, true);
  if (!p || D(a.cash).lt(amount)) return false;
  const qty = exactQuantity ? D(exactQuantity) : D(amount).times(c.config.leverage).div(p).toDecimalPlaces(12, Decimal.ROUND_DOWN);
  if (qty.lte(0)) return false;
  const m = qty.times(p).div(c.config.leverage);
  if (D(a.cash).lt(m)) return false;
  const fee = qty.times(p).times(c.config.feeRate);
  const old = D(c.quantity);
  c.average = str(old.times(c.average).plus(qty.times(p)).div(old.plus(qty)));
  c.quantity = str(old.plus(qty));
  c.margin = add(c.margin, m.minus(fee));
  c.initialMargin = add(c.initialMargin, m);
  c.fees = add(c.fees, fee);
  a.cash = sub(a.cash, m);
  if (c.anchor === "0") c.anchor = p;
  if (grid) {
    c.usedSteps++;
    c.remainingBudget = sub(c.remainingBudget, amount);
  }
  a.fills.push({
    id: randomUUID(), cycleId: c.id, botId: b.id, symbol: c.symbol, action: "increase",
    side: c.direction === "LONG" ? "BUY" : "SELL", quantity: str(qty), price: p, fee: str(fee), realized: "0",
    at: now, reason: grid ? "DCA" : "MANUAL_ADD", source: a.source, model: "PAPER-0.2",
  });
  event(a, "FILL", grid ? "Исполнен шаг сетки" : "Ручная докупка", now, b, c, str(m));
  return true;
}

function reduce(a, b, c, q, percent, reason, now) {
  const p = executionPrice(c, q, false);
  if (!p) return false;
  const qty = D(percent).eq(100)
    ? D(c.quantity)
    : D(c.quantity).times(percent).div(100).toDecimalPlaces(12, Decimal.ROUND_DOWN);
  if (qty.lte(0)) return false;
  const f = qty.div(c.quantity);
  const gross = D(p).minus(c.average).times(qty).times(c.direction === "LONG" ? 1 : -1);
  const fee = qty.times(p).times(c.config.feeRate);
  a.cash = add(a.cash, D(c.margin).times(f).plus(gross).minus(fee));
  c.margin = str(D(c.margin).times(D(1).minus(f)));
  c.initialMargin = str(D(c.initialMargin).times(D(1).minus(f)));
  c.extraMargin = str(D(c.extraMargin).times(D(1).minus(f)));
  c.quantity = sub(c.quantity, qty);
  c.realized = add(c.realized, gross);
  c.fees = add(c.fees, fee);
  a.fills.push({
    id: randomUUID(), cycleId: c.id, botId: b.id, symbol: c.symbol, action: "decrease",
    side: c.direction === "LONG" ? "SELL" : "BUY", quantity: str(qty), price: p, fee: str(fee), realized: str(gross),
    at: now, reason, source: a.source, model: "PAPER-0.2",
  });
  event(a, "FILL", reason, now, b, c, str(gross.minus(fee)));
  if (D(c.quantity).eq(0)) {
    c.status = "CLOSED";
    c.closedAt = now;
    c.closeReason = reason;
    c.remainingBudget = "0";
    b.currentCycleId = null;
    b.pending = [];
    if (reason === "STOP_LOSS" && c.config.accelerationStopOn) {
      a.stopBlacklist ||= [];
      if (!a.stopBlacklist.includes(c.symbol)) a.stopBlacklist.push(c.symbol);
    }
    if (b.finish || reason === "LIQUIDATION" || (reason === "STOP_LOSS" && !c.config.accelerationStopOn)) b.enabled = false;
    b.lastReason = "Сделка завершена";
  }
  return true;
}

/** «Подушка»: держит запас до ликвидации между 15% и 30%, добавляя или возвращая маржу. */
function marginControl(a, b, c, q, now) {
  if (!c.config.marginAuto) return;
  const distance = lr(c, q.mark);
  if (distance === null) return;
  const low = D(distance).lt(15);
  const high = D(distance).gt(30);
  if (!low && !high) return;
  const target = D(q.mark).times(D(1).plus(D(low ? "0.20" : "0.25").times(c.direction === "LONG" ? -1 : 1)));
  const required = c.direction === "LONG"
    ? D(c.quantity).times(c.average).minus(target.times(c.quantity).times("0.995"))
    : target.times(c.quantity).times("1.005").minus(D(c.quantity).times(c.average));
  if (low) {
    const amount = Decimal.min(
      Decimal.max(0, required.minus(c.margin)),
      Decimal.max(0, free(a)),
      Decimal.max(0, D(c.config.marginCap).minus(c.extraMargin)),
    );
    if (amount.gt(0)) {
      a.cash = sub(a.cash, amount);
      c.margin = add(c.margin, amount);
      c.extraMargin = add(c.extraMargin, amount);
      event(a, "MARGIN_ADD", "Добавлена маржа", now, b, c, str(amount));
    }
  } else {
    const amount = Decimal.min(
      Decimal.max(0, D(c.margin).minus(required)),
      D(c.extraMargin),
      Decimal.max(0, D(c.margin).minus(c.initialMargin)),
    );
    if (amount.gt(0)) {
      a.cash = add(a.cash, amount);
      c.margin = sub(c.margin, amount);
      c.extraMargin = sub(c.extraMargin, amount);
      event(a, "MARGIN_RETURN", "Возвращена маржа", now, b, c, str(amount));
    }
  }
}

function openCycle(a, b, q, now) {
  const c = {
    id: randomUUID(), botId: b.id, symbol: q.symbol, direction: q.pickDir || b.config.direction, stage: q.pickWhy,
    config: structuredClone(b.config), version: b.version, status: "OPEN", quantity: "0", average: "0", anchor: "0",
    margin: "0", initialMargin: "0", extraMargin: "0", remainingBudget: b.config.budget, usedSteps: 0, realized: "0",
    fees: "0", funding: "0", openedAt: now, closedAt: null, closeReason: null, lastMark: q.mark,
  };
  const firstAmount = c.config.orderPcts
    ? str(D(c.config.budget).times(c.config.entryPct).div(100))
    : str(D(c.config.budget).div(c.config.steps));
  if (increase(a, b, c, q, firstAmount, true, now)) {
    a.cycles.push(c);
    b.currentCycleId = c.id;
    if (c.direction === 'SHORT') observeFork(c, q, normalizeFork(b.config.fork));
    b.lastReason = "Сделка открыта";
    if (b.config.mode !== "manual") b.lastSignal[q.symbol] = q.pickWhy === "RSI" ? q.signalAt || now : now;
  }
}

/** Выбор монеты для авто-бота среди всех отмеченных стратегий; при нескольких сигналах — больший оборот. */
function pickAuto(a, b, candidates, now) {
  const s = b.config.stages || { ["RSI_" + b.config.direction]: true };
  const picks = [];
  for (const q of candidates) {
    if (a.cycles.some((c) => c.symbol === q.symbol && c.status !== "CLOSED")) continue;
    const stageOk = a.source === "market" && q.stage && (s[q.stage] || (q.stage === "DUMP" && s.DUMP_ACCEL)) && now - (q.stageAt || 0) < 42e5
      && !a.cycles.some((c) => c.symbol === q.symbol && now - (c.closedAt || 0) < 864e5);
    if (stageOk) {
      picks.push({ ...q, pickDir: stageDirection(q.stage), pickWhy: q.stage === "DUMP" && s.DUMP_ACCEL ? "DUMP_ACCEL" : q.stage });
    } else if (
      q.signal && s["RSI_" + q.signal] && (a.source === "scenario" || q.eligible === true)
      && (q.signalAt || 0) > Math.max(b.activatedAt, b.lastSignal[q.symbol] || 0)
      && (q.signalAt || 0) <= now && now - (q.signalAt || 0) < 3e5
    ) {
      picks.push({ ...q, pickDir: q.signal, pickWhy: "RSI" });
    }
  }
  return picks.sort((x, y) => D(y.turnover || 0).cmp(x.turnover || 0) || x.symbol.localeCompare(y.symbol))[0];
}

/** Один шаг жизни счёта: вход, контроль ликвидации, TP/SL, команды, докупки по сетке, снимок капитала. */
export function advance(a, quotes, now) {
  if (a.archived) return;
  const forkOps = { increase, reduce, event, marginControl };
  advancePairs(a, quotes, now, forkOps);
  for (const b of a.bots) {
    const c = a.cycles.find((x) => x.id === b.currentCycleId);
    if (b.forkParentId || c?.forkId) continue;
    if (!c) {
      if (!b.enabled || b.paused || b.finish) continue;
      if (a.walletBlocked) {
        b.lastReason = "Кошелёк в минусе — пополните баланс, чтобы бот открывал новые сделки";
        continue;
      }
      if (a.fundingGaps.length || free(a).lt(0)) {
        b.lastReason = "Недостаточно резерва / сверка фандинга";
        continue;
      }
      const candidates = Object.values(quotes).filter((q) =>
        fresh(q, a, now) && !b.config.exclusions.includes(q.symbol)
        && !(a.stopBlacklist || []).includes(q.symbol)
        && !a.cycles.some((x) => x.status !== "CLOSED" && x.symbol === q.symbol && x.direction === b.config.direction));
      const q2 = b.config.mode === "manual"
        ? candidates.find((q) => q.symbol === b.config.symbol)
        : pickAuto(a, b, candidates, now);
      if (q2) openCycle(a, b, q2, now);
      else b.lastReason = b.config.mode !== "manual" ? "Ждёт сигнала" : "Ждёт цены / свободной монеты";
      continue;
    }
    const q = quotes[c.symbol];
    if (!fresh(q, a, now)) {
      b.lastReason = "Ждёт свежей котировки";
      continue;
    }
    c.lastMark = q.mark;
    if (c.status !== "LIQUIDATING" && D(c.margin).plus(unrealized(c, q.mark)).lte(D(c.quantity).times(q.mark).times("0.005"))) {
      c.status = "LIQUIDATING";
      c.closeReason = "LIQUIDATION";
      c.triggeredAt = now;
      b.pending = [];
      event(a, "LIQUIDATION_TRIGGER", "Достигнут модельный порог ликвидации", now, b, c, q.mark);
    }
    if (c.status === "OPEN") {
      const net = expectedResult(c, q);
      const budget = D(c.config.budget);
      if (net.lte(budget.times(c.config.slPct).div(-100))) {
        c.status = "CLOSING";
        c.closeReason = "STOP_LOSS";
        b.pending = [];
      } else if (c.config.accelerationStopOn && c.direction === "SHORT" && c.usedSteps >= 3
        && q.accelerationAt === Math.floor(now / 3e5) * 3e5
        && now - q.accelerationAt < 6e4
        && Number(q.accelerationGainPct) >= Number(c.config.accelerationStopPct)
        && unrealized(c, q.mark).lt(0) && net.lt(0)) {
        c.status = "CLOSING";
        c.closeReason = "STOP_LOSS";
        c.protectionTrigger = `ACCEL_1H_${c.config.accelerationStopPct}PCT`;
        c.protectionHourGainPct = q.accelerationGainPct;
        c.protectionObservedAt = q.accelerationAt;
        b.pending = [];
      } else if (!a.fundingGaps.length && executionPrice(c, q, false) !== null && net.gte(budget.times(c.config.tpPct).div(100))) {
        c.status = "CLOSING";
        c.closeReason = "TAKE_PROFIT";
        b.pending = [];
      }
    }
    if (c.status !== "OPEN") {
      if (!reduce(a, b, c, q, "100", c.closeReason || "MANUAL", now)) b.lastReason = "Закрытие ждёт bid/ask";
      continue;
    }
    marginControl(a, b, c, q, now);
    for (const p of [...b.pending]) {
      if (c.status !== "OPEN") break;
      if (p.action === "add") {
        if (a.fundingGaps.length || free(a).lt(0)) continue;
        if (increase(a, b, c, q, p.amount, false, now)) b.pending = b.pending.filter((x) => x.id !== p.id);
      } else if (reduce(a, b, c, q, p.percent, "PARTIAL", now)) {
        b.pending = b.pending.filter((x) => x.id !== p.id);
      }
    }
    if (tryOpenFork(a, b, c, q, now, forkOps)) continue;
    guardCheck(a, b, c, q, now);
    if (c.status !== "OPEN" || b.paused || c.dcaLocked || a.fundingGaps.length || free(a).lt(0)) continue;
    while (c.usedSteps < c.config.steps + (c.config.orderPcts ? 1 : 0)) {
      const boundary = gridPrice(c, c.usedSteps);
      if (c.direction === "LONG" ? D(q.mark).gt(boundary) : D(q.mark).lt(boundary)) break;
      const amount = c.config.orderPcts
        ? str(D(c.config.budget).times(c.config.orderPcts[c.usedSteps - 1]).div(100))
        : c.usedSteps === c.config.steps - 1 ? c.remainingBudget : str(D(c.config.budget).div(c.config.steps));
      if (!increase(a, b, c, q, amount, true, now)) break;
    }
  }
  const equity = D(a.cash).plus(
    a.cycles.filter((c) => c.status !== "CLOSED").reduce((s, c) => s.plus(c.margin).plus(unrealized(c, c.lastMark)), D(0)),
  );
  if (equity.gt(a.peakEquity)) a.peakEquity = str(equity);
  const dd = D(a.peakEquity).minus(equity).div(a.peakEquity).times(100);
  if (dd.gt(a.maxDrawdown)) a.maxDrawdown = str(dd);
  if (now - (a.snapshots.at(-1)?.at || 0) >= 5e3) {
    a.snapshots.push({ at: now, equity: str(equity) });
    if (a.snapshots.length > 17280) a.snapshots.shift();
  }
}

/**
 * Подстраховка от резкого движения против позиции. Раз в минуту запоминаем цену; начиная с шага guardStep
 * сравниваем текущую цену с самой выгодной для позиции ценой за последние guardMinutes (в неё входят и цены докупок).
 * Если ушли против позиции на guardPct% и больше — докупки останавливаются, набранная позиция остаётся.
 */
function guardCheck(a, b, c, q, now) {
  const g = c.config;
  if (!g.guardOn || c.dcaLocked) return;
  const win = g.guardMinutes * 6e4;
  c.marks ||= [];
  if (!c.marks.length || now - c.marks.at(-1)[0] >= 6e4) c.marks.push([now, q.mark]);
  while (c.marks.length && now - c.marks[0][0] > win) c.marks.shift();
  if (c.usedSteps < g.guardStep || c.usedSteps >= g.steps) return;
  const short = c.direction === "SHORT";
  const prices = [...c.marks.map((m) => Number(m[1])),
    ...a.fills.filter((f) => f.cycleId === c.id && f.action === "increase" && now - f.at <= win).map((f) => Number(f.price))];
  const ref = short ? Math.min(...prices) : Math.max(...prices);
  if (!(ref > 0)) return;
  const move = (Number(q.mark) / ref - 1) * 100 * (short ? 1 : -1);
  if (move < Number(g.guardPct)) return;
  c.dcaLocked = true;
  c.dcaLockedAt = now;
  b.lastReason = "Подстраховка: докупки остановлены";
  event(a, "GUARD", `Подстраховка: цена ушла против позиции на ${move.toFixed(1)}% за ${g.guardMinutes} мин — докупки остановлены, позиция сохранена`, now, b, c, q.mark);
}

/** Цена шага сетки №step (0 — первый вход) от цены первого входа. */
export function gridPrice(c, step) {
  return D(c.anchor).times(D(1).plus(D(c.config.spacingPct).times(step).div(100).times(c.direction === "LONG" ? -1 : 1)));
}

export function applyFunding(a, f) {
  if (!positive(f.mark) || !D(f.rate).isFinite()) throw Error("Некорректный фандинг");
  for (const c of a.cycles.filter((x) => x.symbol === f.symbol && x.openedAt < f.at && (x.closedAt === null || x.closedAt >= f.at))) {
    const id = `${c.id}:${f.id}`;
    if (a.fundingIds.includes(id)) continue;
    const qty = a.fills.filter((x) => x.cycleId === c.id && x.at < f.at)
      .reduce((s, x) => s.plus(D(x.quantity).times(x.action === "increase" ? 1 : -1)), D(0));
    const amount = qty.times(f.mark).times(f.rate).times(c.direction === "LONG" ? -1 : 1);
    c.funding = add(c.funding, amount);
    if (c.status === "CLOSED") a.cash = add(a.cash, amount);
    else c.margin = add(c.margin, amount);
    a.fundingIds.push(id);
    a.events.push({
      id: randomUUID(), type: "FUNDING", message: "Учтён фандинг", at: f.recordedAt || Date.now(), effectiveAt: f.at,
      cycleId: c.id, botId: c.botId, amount: str(amount),
    });
  }
}

const SYMBOL = /^([A-Z0-9]{1,24})USDT$/;

export function validateConfig(input) {
  const c = structuredClone(input);
  if (!c || typeof c.name !== "string" || !c.name.trim() || c.name.length > 64
    || !["manual", "auto"].includes(c.mode) || !["LONG", "SHORT"].includes(c.direction) || !SYMBOL.test(c.symbol)) {
    throw Error("Некорректные параметры бота");
  }
  const [s0, s1] = LIMITS.steps;
  const [l0, l1] = LIMITS.leverage;
  if (!Number.isInteger(c.steps) || c.steps < s0 || c.steps > s1 || !Number.isInteger(c.leverage) || c.leverage < l0 || c.leverage > l1) {
    throw Error(`Шаги ${s0}–${s1}; плечо ${l0}–${l1}`);
  }
  for (const [key, min, max] of [["budget", 1, 1e7], ["spacingPct", 0.01, 10], ["tpPct", 0.01, 1e4], ["slPct", 0.01, 1e4],
    ["feeRate", 0, 0.01], ["slippageRate", 0, 0.01], ["marginCap", 0, 1e7]]) {
    try {
      const v = D(c[key]);
      if (!v.isFinite() || v.lt(min) || v.gt(max)) throw Error();
      c[key] = str(v);
    } catch {
      throw Error(`Некорректное значение ${key}`);
    }
  }
  if (c.orderPcts !== undefined) {
    if (!Array.isArray(c.orderPcts) || c.orderPcts.length !== 8) throw Error("Нужно задать 8 процентов докупок");
    try {
      const values = [c.entryPct, ...c.orderPcts].map((value) => D(value));
      if (values.some((v) => !v.isFinite() || v.lt("0.01") || v.gt(100))
        || values.slice(0, c.steps + 1).reduce((sum, v) => sum.plus(v), D(0)).gt(100)) throw Error();
      c.entryPct = str(values[0]);
      c.orderPcts = values.slice(1).map(str);
    } catch {
      throw Error("Доли первого входа и докупок должны быть больше 0 и вместе не превышать 100% бюджета сетки");
    }
  }
  // подстраховка: у старых ботов полей нет — считаем выключенной
  c.guardOn = c.guardOn === true;
  c.guardStep = c.guardStep === undefined ? 3 : c.guardStep;
  c.guardPct = c.guardPct === undefined ? "20" : c.guardPct;
  c.guardMinutes = c.guardMinutes === undefined ? 60 : c.guardMinutes;
  c.accelerationStopOn = c.accelerationStopOn === true;
  c.accelerationStopPct = c.accelerationStopPct === undefined ? "10" : c.accelerationStopPct;
  try {
    const pct = D(c.accelerationStopPct);
    if (!pct.isFinite() || pct.lte(0) || pct.gt(100)) throw Error();
    c.accelerationStopPct = str(pct);
  } catch {
    throw Error("Ускорение: допустимый рост за час от 0 до 100%");
  }
  if (!Number.isInteger(c.guardStep) || c.guardStep < 1 || c.guardStep > s1 || !Number.isInteger(c.guardMinutes) || c.guardMinutes < 5 || c.guardMinutes > 240) {
    throw Error("Подстраховка: шаг 1–8, окно 5–240 минут");
  }
  try {
    const gp = D(c.guardPct);
    if (!gp.isFinite() || gp.lt(1) || gp.gt(500)) throw Error();
    c.guardPct = str(gp);
  } catch {
    throw Error("Подстраховка: порог от 1 до 500%");
  }
  if (typeof c.marginAuto !== "boolean" || !Array.isArray(c.exclusions) || c.exclusions.length > 100
    || c.exclusions.some((s) => typeof s !== "string" || !SYMBOL.test(s))) {
    throw Error("Некорректный список исключений");
  }
  const st = c.stages && typeof c.stages === "object" ? c.stages : { ["RSI_" + c.direction]: true };
  c.stages = Object.fromEntries(STRATEGY_KEYS.map((k) => [k, st[k] === true]));
  if (c.stages.DUMP_ACCEL) c.accelerationStopOn = true;
  if (c.mode !== "manual" && !Object.values(c.stages).some(Boolean)) throw Error("Отметьте хотя бы одну стратегию");
  c.fork = normalizeFork(c.fork);
  c.name = c.name.trim();
  return c;
}

export function createBot(a, config, now) {
  if (a.archived || a.bots.filter(b => !b.forkParentId).length >= LIMITS.botsPerAccount) throw Error(`На счёте разрешено до ${LIMITS.botsPerAccount} ботов`);
  const b = {
    id: randomUUID(), config: validateConfig(config), version: 1, enabled: false, paused: false, finish: false,
    currentCycleId: null, activatedAt: 0, lastSignal: {}, lastReason: "Не запущен", pending: [],
  };
  a.bots.push(b);
  event(a, "BOT_CREATED", "Создан бот", now, b);
  return b;
}

export function command(a, botId, action, payload = {}, now = Date.now()) {
  const b = a.bots.find((x) => x.id === botId);
  if (!b || a.archived) throw Error("Бот не найден");
  const c = a.cycles.find((x) => x.id === b.currentCycleId);
  const pair = (a.forks || []).find(f => f.status !== 'CLOSED' && [f.parentBotId, f.childBotId].includes(b.id));
  if (b.forkParentId && action !== 'close') throw Error('Ботом вилки управляет связанная пара');
  if (pair && ['add','partial'].includes(action)) throw Error('Объём активной вилки изменять нельзя — закройте обе позиции');
  if (pair && action === 'close') {
    requestPairClose(pair, 'FORK_MANUAL');
    event(a, 'COMMAND', 'Закрыть обе позиции вилки', now, b, c);
    return;
  }
  switch (action) {
    case 'fork-settings':
      b.config.fork = normalizeFork(payload);
      b.version++;
      break;
    case "start":
      if (b.enabled || c) throw Error("Бот уже запущен");
      if (a.fundingGaps.length) throw Error("Ожидается сверка фандинга");
      if (free(a).lt(b.config.budget)) throw Error("Недостаточно свободных средств для бюджета бота");
      Object.assign(b, { enabled: true, paused: false, finish: false, activatedAt: now, lastReason: "Ждёт цены / сигнала" });
      break;
    case "update":
      b.config = validateConfig(payload);
      b.version++;
      break;
    case "pause":
      if (!b.enabled) throw Error("Бот не запущен");
      b.paused = true;
      break;
    case "resume":
      if (!b.enabled) throw Error("Бот не запущен");
      b.paused = false;
      break;
    case "finish":
      b.finish = true;
      if (!c) b.enabled = false;
      break;
    case "close":
      b.finish = true;
      b.pending = [];
      if (c && c.status !== "LIQUIDATING") {
        c.status = "CLOSING";
        c.closeReason = "MANUAL";
      }
      if (!c) b.enabled = false;
      break;
    case "add":
    case "partial":
      if (!c || c.status !== "OPEN") throw Error("Нет открытой позиции");
      if (b.pending.length >= 10) throw Error("Очередь команд заполнена");
      if (action === "add") {
        if (a.fundingGaps.length) throw Error("Ожидается сверка фандинга");
        if (!positive(payload.amount) || D(payload.amount).gt(1e7) || free(a).lt(payload.amount)) throw Error("Недостаточно свободных средств");
        b.pending.push({ id: randomUUID(), action, amount: str(payload.amount), at: now });
      } else {
        if (!positive(payload.percent) || D(payload.percent).gt(100)) throw Error("Доля должна быть от 0 до 100%");
        b.pending.push({ id: randomUUID(), action, percent: str(payload.percent), at: now });
      }
      break;
    default:
      throw Error("Неизвестная команда");
  }
  event(a, "COMMAND", action, now, b, c);
}

/** Сводка счёта для интерфейса: позиции с текущей ценой, ликвидацией, безубытком и LR. */
export function summarize(a, quotes) {
  const positions = a.cycles.filter((c) => c.status !== "CLOSED").map((c) => {
    const q = quotes[c.symbol];
    const p = q?.source === a.source && positive(q?.mark) ? q.mark : c.lastMark;
    const grid = positive(c.anchor) ? Array.from({ length: c.config.steps + (c.config.orderPcts ? 1 : 0) }, (_, i) => str(gridPrice(c, i))) : [];
    return {
      ...c, mark: p, pnl: str(unrealized(c, p)), net: str(totalResult(c, p)), breakEven: breakEven(c),
      liquidation: liquidation(c), lr: lr(c, p), grid,
    };
  });
  const margin = positions.reduce((s, c) => s.plus(c.margin), D(0));
  const pnl = positions.reduce((s, c) => s.plus(c.pnl), D(0));
  const balance = D(a.cash).plus(margin);
  const equity = balance.plus(pnl);
  return {
    ...a, bots: a.bots.map(b => ({...b, config: {...b.config, fork: normalizeFork(b.config.fork)}})),
    forks: (a.forks || []).map(f => pairView(a, f, quotes[f.symbol])),
    positions, balance: str(balance), equity: str(equity), margin: str(margin), unrealized: str(pnl),
    reserved: str(reserved(a)), free: str(free(a)), net: str(equity.minus(a.initial)),
    preliminary: a.fundingGaps.length > 0, reserveShortfall: free(a).lt(0),
  };
}
