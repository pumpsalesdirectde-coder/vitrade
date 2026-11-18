// Публичные рыночные данные Bybit (USDT-перпетуалы). Только GET, без ключей.
import { D, positive } from "../engine/accounting.js";
import { classifyStage, rsi, rsiSignal } from "../engine/signals.js";

export const BYBIT_API = "https://api.bybit.com";

async function json(fetcher, path) {
  const res = await fetcher(BYBIT_API + path, { signal: AbortSignal.timeout(6e3) });
  if (!res.ok) throw Error(`Bybit HTTP ${res.status}`);
  const body = await res.json();
  if (body.retCode !== 0) throw Error(`Bybit: ${body.retMsg || body.retCode}`);
  return body;
}

/**
 * Котировки: топ-50 по обороту (для RSI), монеты с открытыми позициями и
 * «движущиеся» монеты для стадий (|24ч| ≥ 10% или high/low ≥ 1.15, до 80 шт.).
 */
export async function collectMarket(fetcher, now, cache = {}, held = []) {
  let instruments = cache.instruments || [];
  let universe = cache.universe || [];
  let universeAt = cache.universeAt || 0;
  const refresh = now - universeAt >= 36e5 || !instruments.length;
  if (refresh) {
    instruments = [];
    let cursor = "";
    do {
      const data = await json(fetcher, `/v5/market/instruments-info?category=linear&limit=1000${cursor ? "&cursor=" + encodeURIComponent(cursor) : ""}`);
      instruments.push(...data.result.list
        .filter((i) => i.status === "Trading" && i.quoteCoin === "USDT" && i.contractType === "LinearPerpetual")
        .map((i) => ({ symbol: i.symbol, fundingInterval: i.fundingInterval })));
      cursor = data.result.nextPageCursor || "";
      if (instruments.length > 1e4) throw Error("Слишком много инструментов");
    } while (cursor);
  }
  const data = await json(fetcher, "/v5/market/tickers?category=linear");
  const at = Number(data.time);
  if (!Number.isFinite(at) || Math.abs(now - at) > 15e3) throw Error("Устаревшие котировки Bybit");
  const allowed = new Map(instruments.map((i) => [i.symbol, i]));
  const valid = data.result.list.filter((q) => (allowed.has(q.symbol) || held.includes(q.symbol)) && positive(q.markPrice));
  if (!valid.length) throw Error("Нет корректных котировок");
  if (refresh) {
    universe = valid.filter((q) => allowed.has(q.symbol) && positive(q.turnover24h))
      .sort((a, b) => D(b.turnover24h).cmp(a.turnover24h) || a.symbol.localeCompare(b.symbol))
      .slice(0, 50).map((q) => q.symbol);
    universeAt = now;
  }
  const stageWatch = valid
    .filter((q) => allowed.has(q.symbol) && Number(q.turnover24h) >= 1e5
      && (Math.abs(Number(q.price24hPcnt || 0)) >= 0.1 || Number(q.highPrice24h) / Number(q.lowPrice24h) >= 1.15))
    .sort((a, b) => Number(b.turnover24h) - Number(a.turnover24h)).slice(0, 80).map((q) => q.symbol);
  const quotes = {};
  for (const q of valid.filter((x) => universe.includes(x.symbol) || held.includes(x.symbol) || stageWatch.includes(x.symbol))) {
    const old = cache.quotes?.[q.symbol];
    quotes[q.symbol] = {
      symbol: q.symbol, mark: q.markPrice, bid: q.bid1Price || "", ask: q.ask1Price || "", at, source: "market",
      exchange: "bybit", turnover: positive(q.turnover24h) ? q.turnover24h : "0",
      change: String(Number(q.price24hPcnt || 0) * 100), high24: q.highPrice24h, low24: q.lowPrice24h,
      fundingRate: q.fundingRate, nextFundingAt: Number(q.nextFundingTime) > 0 ? Number(q.nextFundingTime) : old?.nextFundingAt,
      intervalHours: Number(allowed.get(q.symbol)?.fundingInterval || 480) / 60, eligible: universe.includes(q.symbol),
      rsi: old?.rsi, signal: old?.signal, signalAt: old?.signalAt, stage: old?.stage, stageAt: old?.stageAt,
      stagePump: old?.stagePump, stageDrop: old?.stageDrop, stageCheckedAt: old?.stageCheckedAt,
      accelerationAt: old?.accelerationAt, accelerationGainPct: old?.accelerationGainPct,
    };
  }
  return { quotes, instruments, universe, universeAt, stageWatch };
}

/** Стадия по последним 60 закрытым часовым свечам. */
export async function collectStage(fetcher, symbol, now) {
  const hour = Math.floor(now / 36e5) * 36e5;
  const data = await json(fetcher, `/v5/market/kline?category=linear&symbol=${symbol}&interval=60&limit=60`);
  const rows = data.result.list.filter((r) => Number(r[0]) + 36e5 <= now).sort((a, b) => Number(a[0]) - Number(b[0]));
  if (rows.length < 48 || Number(rows.at(-1)[0]) + 36e5 < hour) return { stage: null, stageAt: hour, stageCheckedAt: hour };
  return {
    ...classifyStage(rows.map((r) => Number(r[2])), rows.map((r) => Number(r[3])), rows.map((r) => Number(r[4]))),
    stageAt: hour, stageCheckedAt: hour,
  };
}

/** RSI(14) и сигнал по закрытым 5-минутным свечам. */
export async function collectSignal(fetcher, symbol, now) {
  const data = await json(fetcher, `/v5/market/kline?category=linear&symbol=${symbol}&interval=5&limit=201`);
  const closed = data.result.list.filter((r) => Number(r[0]) + 3e5 <= now).sort((a, b) => Number(a[0]) - Number(b[0]));
  if (closed.length < 101) throw Error("Недостаточная история RSI");
  const end = Number(closed.at(-1)[0]) + 3e5;
  if (now - end > 6e5) throw Error("Устаревшие свечи RSI");
  const prices = closed.map((r) => Number(r[4]));
  return { rsi: rsi(prices) ?? undefined, signal: rsiSignal(prices), signalAt: end };
}

/** Compare closes of completed 5m bars exactly one hour apart. */
export async function collectAcceleration(fetcher, symbol, now) {
  const at = Math.floor(now / 3e5) * 3e5;
  const data = await json(fetcher, `/v5/market/kline?category=linear&symbol=${encodeURIComponent(symbol)}&interval=5&limit=15`);
  const bars = new Map(data.result.list.map((r) => [Number(r[0]), Number(r[4])]));
  for (let t = at - 13 * 3e5; t <= at - 3e5; t += 3e5) {
    if (!Number.isFinite(bars.get(t)) || bars.get(t) <= 0) return { accelerationAt: at, accelerationGainPct: null };
  }
  return { accelerationAt: at, accelerationGainPct: 100 * (bars.get(at - 3e5) / bars.get(at - 13 * 3e5) - 1) };
}

/** Ставка фандинга и mark price на момент расчёта. */
export async function collectFunding(fetcher, symbol, at) {
  const rates = await json(fetcher, `/v5/market/funding/history?category=linear&symbol=${symbol}&startTime=${at - 1}&endTime=${at + 1}&limit=1`);
  const rate = rates.result.list.find((r) => Number(r.fundingRateTimestamp) === at);
  if (!rate) throw Error("Ожидание публикации фандинга");
  const marks = await json(fetcher, `/v5/market/mark-price-kline?category=linear&symbol=${symbol}&interval=1&start=${at}&end=${at + 6e4}&limit=2`);
  const mark = marks.result.list.find((r) => Number(r[0]) === at);
  if (!mark || !positive(mark[1])) throw Error("Не найдена mark price фандинга");
  return { id: `${symbol}:${at}`, symbol, at, rate: rate.fundingRate, mark: mark[1], recordedAt: Date.now() };
}

/** Свечи для графика позиции. */
export async function collectCandles(fetcher, symbol, interval = "15", limit = 200, end = 0) {
  const tail = end > 0 ? `&end=${Math.floor(end)}` : "";
  const data = await json(fetcher, `/v5/market/kline?category=linear&symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}${tail}`);
  return data.result.list.map((r) => ({ t: Number(r[0]), o: +r[1], h: +r[2], l: +r[3], c: +r[4] })).sort((a, b) => a.t - b.t);
}
