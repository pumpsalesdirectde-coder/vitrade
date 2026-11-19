import { BAR5, BAR15, buildSignalBars, detectRange, isTradeBar } from "./detector.js";

const HOUR = 3_600_000;
const INITIAL = 10_000, BUDGET = 500, LEVERAGE = 5;
const TURN_RISK = 25, RANGE_RISK = 50;
const FEE = 0.0005, SLIP = 0.0002, MAINTENANCE = 0.005;
const SIGNAL_TTL = 30_000, QUOTE_TTL = 15_000;
const VALID_SYMBOL = /^[A-Z0-9]{1,30}USDT$/;
const signFor = (direction) => direction === "LONG" ? 1 : -1;
const get = (values, key) => values instanceof Map ? values.get(key) : values?.[key];
const clean = (value) => Number.isFinite(value) && value > 0;

function checkConfig(direction, regime) {
  if (!["LONG", "SHORT"].includes(direction) || !["impulse", "quiet"].includes(regime))
    throw Error("Недопустимое направление или режим диапазона");
}

export function createPaperState({ direction = "LONG", regime = "impulse" } = {}) {
  checkConfig(direction, regime);
  return {
    enabled: false, direction, regime, enabledAt: null, pausedAt: null, marketAt: null,
    marketStatus: "warming", cash: INITIAL, symbols: {}, positions: {}, trades: [], fundingPending: 0,
  };
}

export function configurePaper(state, { enabled, direction = state.direction, regime = state.regime }, now) {
  checkConfig(direction, regime);
  if (typeof enabled !== "boolean") throw Error("Укажите, включён ли PAPER");
  const holding = Object.keys(state.positions).length > 0;
  const changesConfig = direction !== state.direction || regime !== state.regime;
  if (changesConfig && (state.enabled || holding)) throw Error("Сначала выключите PAPER и дождитесь закрытия позиций");
  if (enabled && !state.enabled && holding) throw Error("Дождитесь закрытия позиций");
  if (enabled === state.enabled && !changesConfig) return false;
  state.direction = direction;
  state.regime = regime;
  if (enabled !== state.enabled) {
    state.enabled = enabled;
    state.marketStatus = "warming";
    state.marketAt = null;
    if (enabled) {
      state.enabledAt = now;
      state.pausedAt = null;
      state.symbols = {};
    } else {
      state.pausedAt = now;
      for (const [symbol, track] of Object.entries(state.symbols)) {
        if (!state.positions[symbol]) delete state.symbols[symbol];
        else track.entry = null;
      }
    }
  }
  return true;
}

function quoteAt(quotes, symbol, now) {
  const quote = get(quotes, symbol);
  if (!quote) return null;
  const at = Number(quote.at), bid = Number(quote.bid), ask = Number(quote.ask);
  const last = Number(quote.last), mark = Number(quote.mark);
  if (!clean(at) || at > now || now - at > QUOTE_TTL || !clean(bid) || !clean(ask) || ask < bid) return null;
  return { at, bid, ask, last, mark };
}

function endRange(track, position, reason, at) {
  track.entry = null;
  if (position) {
    track.range.endReason ||= reason;
    position.exit = { reason: track.range.endReason, after: Math.max(at, position.exit?.after ?? 0) };
  } else {
    track.range = null;
    track.readyAt = at + 8 * HOUR;
  }
}

function checkRange(track, position, bars, at, direction, eligible) {
  const bar = bars.at(-1);
  const range = track.range;
  if (!range) return;
  const { L, U, W, M, atr } = range;
  const outside = bar.c < L - 0.15 * atr ? "DOWN" : bar.c > U + 0.15 * atr ? "UP" : null;
  range.outsideCount = outside ? (range.outside === outside ? range.outsideCount + 1 : 1) : 0;
  range.outside = outside;
  if (range.outsideCount === 2) {
    endRange(track, position, "BREAKOUT", at);
    return;
  }
  if (bar.c < L || bar.c > U) {
    range.arm = null;
    range.freshSwingAt = null;
    range.recheck = true;
    return;
  }
  if (position || range.turns >= 2 || range.endReason || at < range.lastExitAt + BAR15) return;
  const sign = signFor(direction);
  if (range.turns > 0 && range.freshSwingAt == null) {
    if (sign * (bar.c - M) > 0) range.freshSwingAt = at;
    return;
  }
  if (range.recheck) {
    const tail = bars.slice(-8);
    if (tail.length !== 8 || tail[0].t !== at - 8 * BAR15
      || tail.filter((row) => row.c >= L && row.c <= U).length < 6) return;
    range.recheck = false;
  }
  const depth = sign > 0 ? bar.c - L : U - bar.c;
  if (range.arm) {
    const age = at - range.arm.at;
    if (age > 0 && age <= 3 * BAR15 && depth > 0.15 * W && depth <= 0.30 * W
      && sign * (bar.c - range.arm.close) >= 0.05 * W) {
      if (eligible) track.entry = { at, armAt: range.arm.at };
      range.arm = null;
    } else if (age >= 3 * BAR15) range.arm = null;
    return;
  }
  const touched = sign > 0 ? bar.l <= L + 0.15 * W : bar.h >= U - 0.15 * W;
  if (depth <= 0.25 * W && touched) range.arm = { at, close: bar.c };
}

function closed15(state, track, position, bars, at, now, eligible) {
  if (track.last15 === at || at <= state.enabledAt) return false;
  const signals = buildSignalBars(bars, at);
  if (signals.at(-1)?.t !== at - BAR15) {
    if (track.range && !track.range.endReason && now > at + SIGNAL_TTL) {
      endRange(track, position, "DATA_GAP", now);
      return true;
    }
    return false;
  }
  if (track.range && track.last15 !== at - BAR15) {
    endRange(track, position, "DATA_GAP", now);
  } else if (track.range && !track.range.endReason) {
    checkRange(track, position, signals, at, state.direction, eligible);
  } else if (!track.range && !position && eligible && at >= track.readyAt && now <= at + SIGNAL_TTL) {
    const detected = detectRange(signals);
    if (detected?.regime === state.regime) track.range = {
      ...detected, detectedAt: at, turns: 0, losses: 0, outsideCount: 0,
      lastExitAt: at, recheck: false, arm: null, freshSwingAt: null, endReason: null,
    };
  }
  track.last15 = at;
  return true;
}

function heldMargin(state) {
  return Object.values(state.positions).reduce((total, p) => total + p.margin, 0);
}

function underMaintenance(collateral, sign, qty, entryPrice, mark) {
  return collateral + sign * qty * (mark - entryPrice) <= mark * qty * MAINTENANCE;
}

function tryOpen(state, symbol, track, quote, now) {
  const range = track.range;
  const sign = signFor(state.direction);
  const mid = (quote.bid + quote.ask) / 2;
  const depth = sign > 0 ? mid - range.L : range.U - mid;
  if (!(depth >= 0 && depth <= 0.30 * range.W) || !clean(quote.mark) || !clean(quote.last)) return;
  const { L, U, W, atr } = range;
  const target = sign > 0 ? L + 0.65 * W : U - 0.65 * W;
  const stop = sign > 0 ? L - 0.65 * atr : U + 0.65 * atr;
  const halfSpreadRate = (quote.ask - quote.bid) / (2 * mid);
  const entryPrice = (sign > 0 ? quote.ask : quote.bid) * (1 + sign * SLIP);
  const targetFill = target * (1 - sign * (halfSpreadRate + SLIP));
  const stopFill = stop * (1 - sign * (halfSpreadRate + SLIP));
  const roundTripCosts = (halfSpreadRate + SLIP) * (mid + target) + FEE * (entryPrice + targetFill);
  if (!clean(stopFill) || sign * (target - mid) < 3 * roundTripCosts || sign * (quote.last - stop) <= 0) return;
  const riskPerUnit = sign * (entryPrice - stopFill) + FEE * (entryPrice + stopFill);
  const available = Math.max(0, Math.min((BUDGET - heldMargin(state)) * LEVERAGE, state.cash / (1 / LEVERAGE + FEE)));
  const qty = Math.min(available / entryPrice, Math.min(TURN_RISK, RANGE_RISK - range.losses) / riskPerUnit);
  const notional = qty * entryPrice;
  if (!clean(riskPerUnit) || !clean(qty) || !Number.isFinite(notional) || notional < 10) return;
  const margin = notional / LEVERAGE;
  const entryFee = notional * FEE;
  if (underMaintenance(margin - entryFee, sign, qty, entryPrice, quote.mark)) return;
  range.turns++;
  state.cash -= margin + entryFee;
  state.positions[symbol] = {
    symbol, direction: state.direction, qty, notional, margin, entryFee, entryPrice, target, stop,
    plannedRisk: qty * riskPerUnit, openedAt: now, mark: quote.mark, markAt: quote.at,
    signalAt: track.entry.at, turn: range.turns, rangeAt: range.detectedAt,
    armAt: track.entry.armAt, freshSwingAt: range.freshSwingAt,
    funding: 0, fundingTimes: [], exit: null,
  };
}

function closePaper(state, track, position, quote, now, reason) {
  const sign = signFor(position.direction);
  const exitPrice = (sign > 0 ? quote.bid : quote.ask) * (1 - sign * SLIP);
  const pricePnL = sign * position.qty * (exitPrice - position.entryPrice);
  const fee = FEE * position.qty * exitPrice;
  const net = pricePnL + position.funding - position.entryFee - fee;
  state.cash += position.margin + pricePnL + position.funding - fee;
  const { exit, ...closed } = position;
  state.trades.push({ ...closed, exitPrice, closedAt: now, reason, net, fees: position.entryFee + fee });
  if (state.trades.length > 400) state.trades.shift();
  delete state.positions[position.symbol];
  const range = track?.range;
  if (!range || !state.enabled) {
    delete state.symbols[position.symbol];
    return;
  }
  range.losses += Math.max(0, -net);
  range.lastExitAt = now;
  range.arm = null;
  range.freshSwingAt = null;
  range.recheck = true;
  if (range.endReason || reason === "LIQUIDATION" || range.losses >= RANGE_RISK) endRange(track, null, reason, now);
}

function applyFunding(state, funding, due, now) {
  if (!funding.length && !due.length && state.fundingPending === 0)
    return { changed: false, blocked: new Set() };
  let changed = false;
  const held = new Map();
  for (const p of [...Object.values(state.positions), ...state.trades]) {
    if (!held.has(p.symbol)) held.set(p.symbol, []);
    held.get(p.symbol).push(p);
  }
  const recordAt = (symbol, at) => held.get(symbol)?.find((p) => p.openedAt < at && (p.closedAt ?? Infinity) >= at);
  for (const f of funding) {
    const mark = Number(f.mark), rate = Number(f.rate);
    if (f.at > now || !clean(mark) || !Number.isFinite(rate)) continue;
    const p = recordAt(f.symbol, f.at);
    if (!p || p.fundingTimes.includes(f.at)) continue;
    const amount = -signFor(p.direction) * p.qty * mark * rate;
    if (!Number.isFinite(amount)) continue;
    p.fundingTimes.push(f.at);
    p.funding += amount;
    if (p.closedAt != null) {
      const previousLoss = Math.max(0, -p.net);
      p.net += amount;
      state.cash += amount;
      const range = state.symbols[p.symbol]?.range;
      if (range?.detectedAt === p.rangeAt) range.losses += Math.max(0, -p.net) - previousLoss;
    }
    changed = true;
  }
  const missing = new Set();
  for (const f of due) {
    if (f.at > now) continue;
    const p = recordAt(f.symbol, f.at);
    if (p && !p.fundingTimes.includes(f.at)) missing.add(`${f.symbol}:${f.at}`);
  }
  if (state.fundingPending !== missing.size) {
    state.fundingPending = missing.size;
    changed = true;
  }
  return { changed, blocked: new Set([...missing].map((key) => key.split(":")[0])) };
}

function exitReason(state, position, quote, now) {
  const sign = signFor(position.direction);
  if (quote.at < position.openedAt) return null;
  if (clean(quote.mark)) {
    const collateral = position.margin - position.entryFee + position.funding;
    if (underMaintenance(collateral, sign, position.qty, position.entryPrice, quote.mark))
      return "LIQUIDATION";
  }
  if (clean(quote.last) && sign * (quote.last - position.stop) <= 0) return "STOP";
  if (!state.enabled && quote.at >= state.pausedAt) return "DISABLED";
  if (position.exit && quote.at >= position.exit.after) return position.exit.reason;
  if (now >= position.openedAt + 4 * HOUR && quote.at >= position.openedAt + 4 * HOUR) return "TURN_TIMEOUT";
  return null;
}

export function advancePaper(state, { now, quotes = {}, universe = new Set(), candles = new Map(), funding = [], fundingDue = [] }) {
  if (!Number.isSafeInteger(now) || now <= 0) throw Error("Недопустимое время PAPER");
  const settlement = applyFunding(state, funding, fundingDue, now);
  let changed = settlement.changed;
  const havePositions = Object.keys(state.positions).length > 0;
  if (!state.enabled && !havePositions) return changed;
  const close5 = Math.floor(now / BAR5) * BAR5;
  const close15 = Math.floor(now / BAR15) * BAR15;
  const eligible = new Set(state.enabled ? [...universe].filter((symbol) => VALID_SYMBOL.test(symbol)) : []);
  const symbols = [...new Set([...eligible, ...Object.keys(state.symbols), ...Object.keys(state.positions)])].sort();
  const validQuotes = new Map();
  let marketAt = null;

  // Examine all exits before allocating freed margin to any new symbol.
  for (const symbol of symbols) {
    const position = state.positions[symbol];
    const bars = get(candles, symbol) || [];
    const quote = quoteAt(quotes, symbol, now);
    if (quote) validQuotes.set(symbol, quote);
    if (quote && eligible.has(symbol)) marketAt = Math.max(marketAt ?? 0, quote.at);
    const track = state.symbols[symbol] || (state.enabled && eligible.has(symbol)
      ? { last15: null, readyAt: 0, range: null, entry: null } : null);
    if (state.enabled && track) {
      if (track.range && !track.range.endReason && (now >= track.range.detectedAt + 16 * HOUR || track.range.losses >= RANGE_RISK)) {
        const risk = track.range.losses >= RANGE_RISK;
        endRange(track, position, risk ? "RISK_LIMIT" : "RANGE_TIMEOUT", risk ? now : track.range.detectedAt + 16 * HOUR);
        changed = true;
      }
      if (closed15(state, track, position, bars, close15, now, eligible.has(symbol))) {
        state.symbols[symbol] = track;
        changed = true;
      }
    }
    if (!position) continue;
    if (quote && quote.at > position.markAt && clean(quote.mark)) {
      position.mark = quote.mark;
      position.markAt = quote.at;
      changed = true;
    }
    if (state.enabled && track?.range && !track.range.endReason && close5 > position.openedAt) {
      const bar = bars.findLast((b) => b?.t === close5 - BAR5);
      if (!isTradeBar(bar) && now > close5 + SIGNAL_TTL) {
        endRange(track, position, "DATA_GAP", now);
        changed = true;
      } else if (!position.exit && isTradeBar(bar) && signFor(position.direction) * (bar.c - position.target) >= 0) {
        position.exit = { reason: "TAKE_PROFIT", after: close5 };
        changed = true;
      }
    }
    const reason = quote && exitReason(state, position, quote, now);
    if (reason) {
      closePaper(state, track, position, quote, now, reason);
      changed = true;
    }
  }

  if (state.enabled) {
    const marketStatus = marketAt == null ? "warming" : "scanning";
    if (marketAt !== state.marketAt || marketStatus !== state.marketStatus) {
      state.marketAt = marketAt;
      state.marketStatus = marketStatus;
      changed = true;
    }
    for (const symbol of symbols) {
      const track = state.symbols[symbol];
      if (!track) continue;
      const entry = track.entry;
      if (!eligible.has(symbol) && !state.positions[symbol] && !track.range && now >= track.readyAt) {
        delete state.symbols[symbol];
        changed = true;
      } else if (entry) {
        const invalid = !eligible.has(symbol) || !track.range || state.positions[symbol] || now > entry.at + SIGNAL_TTL;
        const quote = validQuotes.get(symbol);
        if (invalid || (quote && quote.at >= entry.at && !settlement.blocked.has(symbol))) {
          if (!invalid) tryOpen(state, symbol, track, quote, now);
          track.entry = null;
          changed = true;
        }
      }
    }
  }
  return changed;
}

export function paperView(state) {
  const positions = Object.values(state.positions).map(({ fundingTimes, exit, ...p }) => ({
    ...p, pendingExit: exit?.reason ?? null,
    unrealized: signFor(p.direction) * p.qty * (p.mark - p.entryPrice) + p.funding,
  }));
  const usedMargin = positions.reduce((total, p) => total + p.margin, 0);
  const equity = state.cash + usedMargin + positions.reduce((total, p) => total + p.unrealized, 0);
  return {
    enabled: state.enabled, status: state.enabled ? state.marketStatus : positions.length ? "draining" : "disabled",
    direction: state.direction, regime: state.regime, enabledAt: state.enabledAt, marketAt: state.marketAt,
    initial: INITIAL, budget: BUDGET, leverage: LEVERAGE, cash: state.cash, equity, usedMargin,
    fundingPending: state.fundingPending, positions, trades: state.trades.slice(-100).map(({ fundingTimes, ...p }) => p),
  };
}
