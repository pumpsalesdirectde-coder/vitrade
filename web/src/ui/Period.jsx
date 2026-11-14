import { useState } from "react";

const DAY = 864e5;
const startOfDay = (t) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
const MONTHS = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
const iso = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** Границы периода [from, to) в миллисекундах; null — без ограничения. */
export function periodRange(p, now = Date.now()) {
  const today = startOfDay(now);
  switch (p.kind) {
    case "today": return [today, today + DAY];
    case "yesterday": return [today - DAY, today];
    case "7d": return [now - 7 * DAY, null];
    case "30d": return [now - 30 * DAY, null];
    case "month": {
      const [y, m] = p.month.split("-").map(Number);
      return [new Date(y, m - 1, 1).getTime(), new Date(y, m, 1).getTime()];
    }
    case "custom": return [p.from ? new Date(p.from + "T00:00").getTime() : null, p.to ? new Date(p.to + "T00:00").getTime() + DAY : null];
    default: return [null, null];
  }
}

export const inRange = ([from, to], t) => t !== null && t !== undefined && (from === null || t >= from) && (to === null || t < to);

export function usePeriod() {
  const now = new Date();
  return useState({ kind: "all", month: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`, from: iso(Date.now() - 7 * DAY), to: iso(Date.now()) });
}

/** Переключатель периода: Всё, Сегодня, Вчера, 7Д, 30Д, месяц из списка, свой период. */
export default function Period({ value: p, onChange }) {
  const set = (patch) => onChange({ ...p, ...patch });
  const now = new Date();
  const months = Array.from({ length: 12 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    return [`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`, `${MONTHS[d.getMonth()]} ${d.getFullYear()}`];
  });
  return (
    <div className="period">
      <div className="seg" role="group" aria-label="Период">
        {[["all", "Всё время"], ["today", "Сегодня"], ["yesterday", "Вчера"], ["7d", "7Д"], ["30d", "30Д"]].map(([k, l]) => (
          <button key={k} aria-pressed={p.kind === k} onClick={() => set({ kind: k })}>{l}</button>
        ))}
      </div>
      <select aria-label="Месяц" className={p.kind === "month" ? "on" : ""} value={p.kind === "month" ? p.month : ""} onChange={(e) => set({ kind: "month", month: e.target.value })}>
        <option value="" disabled>Месяц…</option>
        {months.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
      <div className={`period-custom ${p.kind === "custom" ? "on" : ""}`}>
        <label><span>с</span><input type="date" value={p.from} max={p.to} onChange={(e) => set({ kind: "custom", from: e.target.value })} /></label>
        <label><span>по</span><input type="date" value={p.to} min={p.from} onChange={(e) => set({ kind: "custom", to: e.target.value })} /></label>
      </div>
    </div>
  );
}
