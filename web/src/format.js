const nf = (d) => new Intl.NumberFormat("ru-RU", { minimumFractionDigits: d, maximumFractionDigits: d });
const cache = {};
const f = (d) => (cache[d] ||= nf(d));

// Денежные суммы выводятся со знаком $ (1 USDT ≈ 1 $). unit = "" — просто число.
export const money = (v, d = 2, unit = "\u00a0$") => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? "—" : f(d).format(Number(v)) + unit);
export const signed = (v, d = 2, unit = "\u00a0$") => {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return (n > 0 ? "+" : n < 0 ? "−" : "") + f(d).format(Math.abs(n)) + unit;
};

/** Цена с разумным числом знаков: 67 412,5 / 0,08231 / 0,0000123. */
export function price(v, unit = " $") {
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return "—";
  const d = n >= 1000 ? 1 : n >= 1 ? 4 : Math.min(8, 2 - Math.floor(Math.log10(n)) + 2);
  return f(d).format(n) + unit;
}

export const pct = (v, d = 1) => (Number.isFinite(Number(v)) ? f(d).format(Number(v)) + "%" : "—");
export const tone = (v) => (Number(v) > 0 ? "up" : Number(v) < 0 ? "down" : "flat");

export function duration(from, to = Date.now()) {
  const ms = Math.max(0, to - from);
  const h = Math.floor(ms / 36e5);
  const m = Math.floor((ms % 36e5) / 6e4);
  if (h >= 24) return `${Math.floor(h / 24)} д ${h % 24} ч`;
  if (h > 0) return `${h} ч ${m} мин`;
  return `${m} мин`;
}

export const when = (t) =>
  t ? new Date(t).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";

export const coin = (symbol) => (symbol || "").replace(/USDT$/, "");

export const STRATEGY = {
  RSI_SHORT: { short: "RSI ↓", name: "RSI · шорт", about: "RSI(14) на 5-минутках вернулся ниже 70 после перекупленности. 50 самых ликвидных монет." },
  RSI_LONG: { short: "RSI ↑", name: "RSI · лонг", about: "RSI(14) на 5-минутках вернулся выше 30 после перепроданности. 50 самых ликвидных монет." },
  PUMP: { short: "Памп", name: "Памп", about: "Цена выросла на 15%+ и держится у вершины. Шорт на продолжении — самый рискованный вход." },
  EARLY: { short: "Ранний", name: "Ранний разворот", about: "После пампа 15%+ цена отошла от вершины на 3–5%. Шорт." },
  FLIP: { short: "Разворот", name: "Подтверждённый разворот", about: "После пампа 20%+ откат 5–12% от вершины. Шорт." },
  DUMP: { short: "Слив", name: "Слив", about: "После пампа 20%+ падение 12–40% и цена ниже, чем 3 часа назад. Шорт по тренду." },
  CRASH: { short: "Отскок", name: "Отскок после обвала", about: "Обвал 25%+ от недавней вершины и первые признаки отскока. Лонг." },
};
export const STRATEGY_ORDER = ["EARLY", "FLIP", "DUMP", "PUMP", "CRASH", "RSI_SHORT", "RSI_LONG"];

export const entryLabel = (cycle) =>
  cycle.forkId && cycle.direction === "LONG" ? "Вилка · лонг"
    : cycle.stage === "RSI" ? STRATEGY[`RSI_${cycle.direction}`].short
    : cycle.stage ? STRATEGY[cycle.stage]?.short || cycle.stage
      : cycle.config?.mode === "manual" ? "Вручную" : "RSI";

export const CLOSE_REASON = {
  TAKE_PROFIT: "Тейк-профит", STOP_LOSS: "Стоп-лосс", MANUAL: "Закрыта вручную", LIQUIDATION: "Ликвидация", PARTIAL: "Частично",
  FORK_TARGET: "Вилка: общий результат достигнут", FORK_STOP: "Вилка: предел дополнительного убытка", FORK_TIMEOUT: "Вилка: истекло время",
  FORK_MANUAL: "Вилка: обе позиции закрыты вручную", FORK_LIQUIDATION: "Вилка: ликвидация одной из сторон", FORK_ORPHAN: "Вилка: закрытие оставшейся стороны",
};

export const forkReason = (reason) => CLOSE_REASON[reason] || ({ RAPID: "Быстрый рост цены", TOTAL: "Общий рост от первого входа", OPEN: "Пара открыта", CLOSING: "Пара закрывается", CLOSED: "Пара закрыта" }[reason]) || reason || "—";

/** Состояние бота простыми словами. */
export function botStatus(b, cycle) {
  if (cycle?.status === "LIQUIDATING") return { key: "danger", text: "Ликвидация" };
  if (cycle?.status === "CLOSING") return { key: "busy", text: "Закрывается" };
  if (cycle?.forkId) return { key: "live", text: "Вилка · совместный выход" };
  if (cycle && b.paused) return { key: "hold", text: "В позиции · докупки на паузе" };
  if (cycle?.dcaLocked) return { key: "hold", text: "В позиции · подстраховка остановила докупки" };
  if (cycle && b.finish) return { key: "busy", text: "Доводит сделку и остановится" };
  if (cycle) return { key: "live", text: "В позиции" };
  if (!b.enabled) return { key: "off", text: "Остановлен" };
  if (b.paused) return { key: "hold", text: "На паузе" };
  return { key: "wait", text: b.config.mode === "manual" ? "Ждёт входа" : "Ждёт сигнала" };
}
