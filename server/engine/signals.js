// Сигналы входа: RSI(14) на 5-минутках и стадии памп-цикла на часовых свечах.

export const STAGE_KEYS = ["PUMP", "EARLY", "FLIP", "DUMP", "CRASH"];
export const STRATEGY_KEYS = ["RSI_SHORT", "RSI_LONG", ...STAGE_KEYS];

export function rsi(prices, period = 14) {
  if (prices.length < period + 1 || prices.some((p) => !Number.isFinite(p) || p <= 0)) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const ch = prices[i] - prices[i - 1];
    gain += Math.max(0, ch);
    loss += Math.max(0, -ch);
  }
  gain /= period;
  loss /= period;
  for (let i = period + 1; i < prices.length; i++) {
    const ch = prices[i] - prices[i - 1];
    gain = (gain * (period - 1) + Math.max(0, ch)) / period;
    loss = (loss * (period - 1) + Math.max(0, -ch)) / period;
  }
  if (gain === 0 && loss === 0) return 50;
  if (loss === 0) return 100;
  if (gain === 0) return 0;
  return 100 - 100 / (1 + gain / loss);
}

/** LONG — RSI вышел вверх из зоны ниже 30; SHORT — вышел вниз из зоны выше 70. */
export function rsiSignal(prices) {
  if (prices.length < 101) return undefined;
  const prev = rsi(prices.slice(0, -1));
  const last = rsi(prices);
  if (prev === null || last === null) return undefined;
  if (prev <= 30 && last > 30) return "LONG";
  if (prev >= 70 && last < 70) return "SHORT";
  return undefined;
}

/**
 * Стадия памп-цикла по закрытым часовым свечам (те же правила, что crypto-bot/stages.py;
 * сверено на 139 170 точках истории без расхождений).
 */
export function classifyStage(h, l, c) {
  const n = c.length;
  const i = n - 1;
  if (n < 48) return { stage: null };
  const win = h.slice(n - 24);
  const peak = Math.max(...win);
  const base = Math.min(...l.slice(n - 48));
  const pump = peak / base - 1;
  const drop = 1 - c[i] / peak;
  let stage = null;
  if (pump >= 0.15 && drop < 0.03) stage = "PUMP";
  if (pump >= 0.15 && drop >= 0.03 && drop < 0.05) stage = "EARLY";
  if (pump >= 0.2 && drop >= 0.05 && drop < 0.12) stage = "FLIP";
  if (pump >= 0.2 && drop >= 0.12 && drop < 0.4 && c[i] < c[i - 3]) stage = "DUMP";
  let last = 0;
  for (let k = 0; k < 24; k++) if (win[k] === peak) last = k;
  const low3 = Math.min(...l.slice(n - 3));
  if (drop >= 0.25 && 23 - last <= 12 && c[i] >= low3 * 1.01) stage = "CRASH";
  return { stage, stagePump: pump, stageDrop: drop };
}

/** Направление сделки для стадии: CRASH — отскок вверх, остальные — шорт. */
export const stageDirection = (stage) => (stage === "CRASH" ? "LONG" : "SHORT");
