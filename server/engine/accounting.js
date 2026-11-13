// Денежный учёт позиции. Перенесено из VITrade 0.1.0 (domain/accounting.ts) без изменения формул.
import Decimal from "decimal.js";

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });

export const D = (v) => new Decimal(v);
export const str = (v) => D(v).toDecimalPlaces(18).toFixed();
export const add = (a, b) => str(D(a).plus(b));
export const sub = (a, b) => str(D(a).minus(b));
export { Decimal };

export function positive(v) {
  try {
    return D(v).isFinite() && D(v).gt(0);
  } catch {
    return false;
  }
}

const sign = (c) => (c.direction === "LONG" ? 1 : -1);

export const unrealized = (c, price) => D(price).minus(c.average).times(c.quantity).times(sign(c));
export const realizedNet = (c) => D(c.realized).plus(c.funding).minus(c.fees);
export const totalResult = (c, price = c.lastMark) =>
  realizedNet(c).plus(c.status === "CLOSED" ? 0 : unrealized(c, price));

/** Цена исполнения с проскальзыванием: покупка по ask, продажа по bid. */
export function executionPrice(c, q, increasing) {
  if (!positive(q.bid) || !positive(q.ask) || D(q.bid).gt(q.ask)) return null;
  const buy = increasing ? c.direction === "LONG" : c.direction === "SHORT";
  return str(D(buy ? q.ask : q.bid).times(D(1).plus(D(c.config.slippageRate).times(buy ? 1 : -1))));
}

export function expectedResult(c, q) {
  const p = executionPrice(c, q, false) || q.mark;
  return totalResult(c, p).minus(D(c.quantity).times(p).times(c.config.feeRate));
}

/** Сколько денег счёта зарезервировано ботами (остаток бюджета сетки + отложенные докупки). */
export function reserved(a) {
  return a.bots.reduce((sum, b) => {
    const c = a.cycles.find((x) => x.id === b.currentCycleId);
    const base = c && c.status !== "CLOSED" ? c.remainingBudget : b.enabled ? b.config.budget : 0;
    const pending = b.pending.reduce((n, p) => n.plus(p.action === "add" ? p.amount || 0 : 0), D(0));
    return sum.plus(base).plus(pending);
  }, D(0));
}

export const free = (a) => D(a.cash).minus(reserved(a));

export function liquidation(c) {
  if (!positive(c.quantity)) return null;
  const n = D(c.quantity).times(c.average);
  return str(
    c.direction === "LONG"
      ? n.minus(c.margin).div(D(c.quantity).times("0.995"))
      : n.plus(c.margin).div(D(c.quantity).times("1.005")),
  );
}

/** Запас до ликвидации в % от текущей mark price. */
export function lr(c, mark) {
  const l = liquidation(c);
  if (l === null || !positive(mark)) return null;
  return str(D(c.direction === "LONG" ? D(mark).minus(l) : D(l).minus(mark)).div(mark).times(100));
}

export function breakEven(c) {
  if (!positive(c.quantity)) return null;
  const cash = realizedNet(c);
  const base = D(c.quantity).times(c.average);
  return str(
    c.direction === "LONG"
      ? base.minus(cash).div(D(c.quantity).times(D(1).minus(c.config.feeRate)))
      : base.plus(cash).div(D(c.quantity).times(D(1).plus(c.config.feeRate))),
  );
}
