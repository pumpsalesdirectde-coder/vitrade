export const BAR5 = 300_000;
export const BAR15 = 3 * BAR5;

export function isTradeBar(bar) {
  return !!bar && Number.isSafeInteger(bar.t) && bar.t % BAR5 === 0
    && [bar.o, bar.h, bar.l, bar.c].every((price) => Number.isFinite(price) && price > 0)
    && bar.h >= Math.max(bar.o, bar.c) && bar.l <= Math.min(bar.o, bar.c)
    && Number.isFinite(bar.qv) && bar.qv > 0
    && Number.isFinite(bar.trades) && bar.trades > 0;
}

export function buildSignalBars(bars, closedThrough) {
  const result = [];
  for (let i = 0; i + 2 < bars.length; i++) {
    const a = bars[i];
    if (!a || a.t % BAR15 !== 0 || a.t + BAR15 > closedThrough) continue;
    const b = bars[i + 1], c = bars[i + 2];
    if (b?.t !== a.t + BAR5 || c?.t !== a.t + 2 * BAR5 || ![a, b, c].every(isTradeBar)) continue;
    result.push({ t: a.t, o: a.o, h: Math.max(a.h, b.h, c.h), l: Math.min(a.l, b.l, c.l), c: c.c });
  }
  return result;
}

function countVisits(window, L, U, W, M) {
  let side = 0, last = -2, visits = 0;
  for (let i = 0; i < window.length; i++) {
    const bar = window[i];
    const lower = bar.l <= L + 0.15 * W && bar.c <= M;
    const upper = bar.h >= U - 0.15 * W && bar.c >= M;
    if (lower === upper) continue;
    const visit = lower ? -1 : 1;
    if (visit === side || i - last < 2) continue;
    side = visit;
    last = i;
    visits++;
  }
  return visits;
}

// Same quantiles, spacing, impulse and volatility tests as the historical V2 detector.
export function detectRange(bars) {
  const last40 = bars.slice(-40);
  if (last40.length !== 40 || last40.some((b, i) => i > 0 && b.t !== last40[i - 1].t + BAR15)) return null;
  const window = last40.slice(8);
  const L = window.map((b) => b.l).sort((a, b) => a - b)[3];
  const U = window.map((b) => b.h).sort((a, b) => a - b)[28];
  const W = U - L, M = (L + U) / 2;
  const width = W / M;
  const lastClose = window.at(-1).c;
  if (!(width >= 0.012 && width <= 0.1) || lastClose < L || lastClose > U
      || Math.abs(lastClose - window[0].c) / W > 0.45) return null;
  let trSum = 0;
  for (let i = 18; i < 32; i++) {
    const previous = window[i - 1].c;
    trSum += Math.max(window[i].h, previous) - Math.min(window[i].l, previous);
  }
  const atr = trSum / 14;
  if (W < 2.5 * atr || W > 10 * atr || window.filter((b) => b.c >= L && b.c <= U).length < 26
      || countVisits(window, L, U, W, M) < 4) return null;

  const prior = last40.slice(0, 8);
  let travelled = Math.abs(prior[0].c - prior[0].o);
  for (let i = 1; i < prior.length; i++) travelled += Math.abs(prior[i].c - prior[i - 1].c);
  const delta = prior.at(-1).c - prior[0].o;
  const impulse = travelled > 0 && Math.abs(delta) / travelled >= 0.6
    && Math.abs(delta) / prior[0].o >= Math.max(0.02, 0.75 * width);
  return { L, U, W, M, atr, regime: impulse ? "impulse" : "quiet", impulseSign: impulse ? Math.sign(delta) : 0 };
}
