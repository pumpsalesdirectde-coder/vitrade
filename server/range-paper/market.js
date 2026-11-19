import { BYBIT_API } from "../market/bybit.js";

export const FIVE_MINUTES = 300_000;
const HOUR = 3_600_000;
const SYMBOL = /^[A-Z0-9]{2,30}$/;
const positive = (value) => Number.isFinite(value) && value > 0;

export function hourlyPaperUniverse(cache, quotes, now, previous = null) {
  const hour = Math.floor(now / HOUR) * HOUR;
  if (previous?.hour === hour) return previous;
  const ranked = [...new Set(Array.isArray(cache?.universe) ? cache.universe : [])]
    .filter(symbol => typeof symbol === "string" && SYMBOL.test(symbol))
    .flatMap(symbol => {
      const quote = Object.hasOwn(quotes, symbol) ? quotes[symbol] : null;
      const at = Number(quote?.at);
      const turnover = Number(quote?.turnover);
      return Number.isFinite(at) && at >= hour && now - at >= 0 && now - at <= 15_000 && Number.isFinite(turnover)
        ? [{ symbol, turnover }]
        : [];
    });
  if (!ranked.length) return null;
  ranked.sort((a, b) => b.turnover - a.turnover || a.symbol.localeCompare(b.symbol, "en"));
  return { hour, symbols: new Set(ranked.filter(row => row.turnover >= 10_000_000).slice(0, 30).map(row => row.symbol)) };
}

/** Bybit trade kline supplies volume and turnover, but no trade count. */
export async function fetchPaperCandles(fetcher, symbol, now) {
  if (typeof symbol !== "string" || !SYMBOL.test(symbol)) throw Error("Недопустимый символ свечей PAPER");
  const url = new URL("/v5/market/kline", BYBIT_API);
  url.search = new URLSearchParams({ category: "linear", symbol, interval: "5", limit: "150" });
  const response = await fetcher(url.toString(), { signal: AbortSignal.timeout(3_000) });
  if (!response.ok) throw Error(`Bybit HTTP ${response.status}`);
  const data = await response.json();
  if (data.retCode !== 0 || !Array.isArray(data.result?.list)) throw Error("Некорректные свечи Bybit");
  const exchangeTime = Number(data.time);
  if (!Number.isSafeInteger(exchangeTime) || exchangeTime <= 0) throw Error("Bybit не подтвердил время закрытия свечей");
  const closedBy = Math.min(now, exchangeTime);

  const valid = new Map();
  const duplicate = new Set();
  for (const row of data.result.list.slice(0, 150)) {
    if (!Array.isArray(row) || row.length < 7) continue;
    const [t, o, h, l, c, volume, qv] = row.slice(0, 7).map(Number);
    if (!Number.isSafeInteger(t) || t <= 0 || t % FIVE_MINUTES !== 0 || t + FIVE_MINUTES > closedBy) continue;
    if (![o, h, l, c, volume, qv].every(positive) || h < Math.max(o, c) || l > Math.min(o, c)) continue;
    if (valid.has(t)) duplicate.add(t);
    valid.set(t, { t, o, h, l, c, qv, trades: 1 });
  }
  for (const t of duplicate) valid.delete(t);
  return [...valid.values()].sort((a, b) => a.t - b.t);
}
