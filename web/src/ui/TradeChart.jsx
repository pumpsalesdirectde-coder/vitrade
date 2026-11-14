import { useEffect, useMemo, useRef, useState } from "react";
import { get } from "../api.js";
import { CLOSE_REASON, coin, duration, entryLabel, money, price, signed, tone, when } from "../format.js";
import Hint from "./Hint.jsx";

// Интервалы свечей Bybit в минутах
const INTERVALS = [["1", 1], ["5", 5], ["15", 15], ["60", 60], ["240", 240], ["D", 1440]];
const LABEL = { 1: "1м", 5: "5м", 15: "15м", 60: "1ч", 240: "4ч", 1440: "1д" };
const MAX_CANDLES = 240;

/** Окно графика: сделка в середине, по краям запас, чтобы был виден контекст. */
function windowFor(cycle, now) {
  const from = cycle.openedAt;
  const to = cycle.closedAt || now;
  const span = Math.max(to - from, 30 * 6e4);
  const pad = span * 0.35;
  return { start: from - pad, end: Math.min(now, to + pad) };
}

function autoInterval(win) {
  const minutes = (win.end - win.start) / 6e4;
  return (INTERVALS.find(([, m]) => minutes / m <= MAX_CANDLES) || INTERVALS.at(-1))[0];
}

/** Треугольник-метка: вершина вниз для продажи, вверх для покупки. */
function Mark({ x, y, down, cls, size = 9 }) {
  const s = size;
  const d = down ? `M${x - s},${y - s * 1.9} L${x + s},${y - s * 1.9} L${x},${y - s * 0.3} Z` : `M${x - s},${y + s * 1.9} L${x + s},${y + s * 1.9} L${x},${y + s * 0.3} Z`;
  return <path d={d} className={`tc-mark ${cls}`} />;
}

export default function TradeChart({ account, cycle, position, onClose }) {
  const [now] = useState(() => Date.now());
  const win = useMemo(() => windowFor(cycle, now), [cycle, now]);
  const [interval, setInterval_] = useState(() => autoInterval(win));
  const [candles, setCandles] = useState(null);
  const [fills, setFills] = useState([]);
  const [err, setErr] = useState("");
  // ширина графика = ширина блока, чтобы на телефоне подписи не мельчали
  const box = useRef(null);
  const [boxW, setBoxW] = useState(760);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setBoxW(Math.max(280, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    get(`/api/accounts/${account.id}/fills`).then((all) => setFills(all.filter((f) => f.cycleId === cycle.id))).catch(() => {});
  }, [account.id, cycle.id]);

  useEffect(() => {
    const m = INTERVALS.find(([k]) => k === interval)[1];
    const limit = Math.min(1000, Math.ceil((win.end - win.start) / (m * 6e4)) + 4);
    setCandles(null);
    setErr("");
    get(`/api/candles?symbol=${cycle.symbol}&interval=${interval}&limit=${Math.max(20, limit)}&end=${Math.floor(win.end)}`)
      .then((r) => setCandles(r.candles))
      .catch((e) => setErr(e.message));
  }, [interval, cycle.symbol, win]);

  const short = cycle.direction === "SHORT";
  const pos = position || cycle;
  const exitFill = fills.filter((f) => f.action === "decrease").at(-1);
  const exitPrice = cycle.status === "CLOSED" ? Number(exitFill?.price || cycle.lastMark) : null;
  const total = Number(cycle.realized) + Number(cycle.funding) - Number(cycle.fees) + (cycle.status === "CLOSED" ? 0 : Number(pos.pnl || 0));
  const budget = Number(cycle.config.budget);

  // Горизонтальные уровни на графике
  const levels = [];
  if (Number(pos.average) > 0) levels.push({ y: Number(pos.average), label: "средняя", cls: "lv-avg" });
  if (exitPrice) levels.push({ y: exitPrice, label: "закрытие", cls: total >= 0 ? "lv-win" : "lv-loss" });
  if (cycle.status !== "CLOSED") {
    if (Number(pos.mark) > 0) levels.push({ y: Number(pos.mark), label: "сейчас", cls: "lv-now" });
    if (Number(pos.breakEven) > 0) levels.push({ y: Number(pos.breakEven), label: "БУ", cls: "lv-be", hint: "breakeven" });
    if (Number(pos.liquidation) > 0) levels.push({ y: Number(pos.liquidation), label: "ликвидация", cls: "lv-liq", hint: "liq" });
  }
  const pendingGrid = cycle.status !== "CLOSED" ? (pos.grid || []).slice(cycle.usedSteps, cycle.usedSteps + 3).map(Number) : [];

  const W = boxW, H = Math.round(Math.min(380, Math.max(300, boxW * 0.62))), L = 6, R = W < 500 ? 84 : 92, T = 22, B = 24;
  let chart = null;
  if (candles?.length) {
    const t0 = candles[0].t;
    const step = candles.length > 1 ? candles[1].t - candles[0].t : 6e4;
    const t1 = candles.at(-1).t + step;
    const prices = [...candles.flatMap((c) => [c.h, c.l]), ...levels.map((l) => l.y), ...fills.map((f) => Number(f.price))];
    const near = pendingGrid.filter((g) => g < Math.max(...prices) * 1.25 && g > Math.min(...prices) * 0.8);
    prices.push(...near);
    let lo = Math.min(...prices), hi = Math.max(...prices);
    const padY = (hi - lo) * 0.08 || hi * 0.01;
    lo -= padY;
    hi += padY;
    const x = (t) => L + ((t - t0) / (t1 - t0)) * (W - L - R);
    const y = (p) => T + (1 - (p - lo) / (hi - lo)) * (H - T - B);
    const cw = Math.max(1, ((W - L - R) / candles.length) * 0.62);
    const ticks = Array.from({ length: 5 }, (_, i) => lo + ((hi - lo) * (i + 0.5)) / 5);
    const days = [];
    for (let i = 0; i < candles.length; i += Math.ceil(candles.length / (W < 500 ? 4 : 6))) days.push(candles[i].t);
    // подписи уровней не должны наезжать друг на друга
    const tags = [...levels].sort((a, b) => y(a.y) - y(b.y));
    let lastY = -Infinity;
    for (const t of tags) {
      t.ty = Math.max(y(t.y), lastY + 17);
      lastY = t.ty;
    }
    const increases = fills.filter((f) => f.action === "increase");
    chart = (
      <svg className="tc-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`График ${coin(cycle.symbol)} с точками входа, докупок и выхода`}>
        {ticks.map((p) => (
          <g key={p}>
            <line x1={L} x2={W - R} y1={y(p)} y2={y(p)} className="tc-grid" />
            <text x={W - R + 6} y={y(p) + 4} className="tc-axis">{price(p)}</text>
          </g>
        ))}
        {days.map((t) => <text key={t} x={Math.max(22, Math.min(W - R - 22, x(t)))} y={H - 6} className="tc-axis" textAnchor="middle">{new Date(t).toLocaleString("ru-RU", t1 - t0 >= 36 * 36e5 ? { day: "2-digit", month: "2-digit" } : { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}</text>)}
        <rect x={x(cycle.openedAt)} width={Math.max(1, x(cycle.closedAt || t1) - x(cycle.openedAt))} y={T} height={H - T - B} className="tc-span" />
        {pendingGrid.filter((g) => g > lo && g < hi).map((g) => <line key={g} x1={x(cycle.openedAt)} x2={W - R} y1={y(g)} y2={y(g)} className="tc-pending" />)}
        {candles.map((c) => {
          const up = c.c >= c.o;
          const cx = x(c.t + step / 2);
          return (
            <g key={c.t} className={up ? "tc-up" : "tc-down"}>
              <line x1={cx} x2={cx} y1={y(c.h)} y2={y(c.l)} />
              <rect x={cx - cw / 2} width={cw} y={y(Math.max(c.o, c.c))} height={Math.max(1, Math.abs(y(c.o) - y(c.c)))} />
            </g>
          );
        })}
        {levels.map((l) => <line key={l.label} x1={L} x2={W - R} y1={y(l.y)} y2={y(l.y)} className={`tc-level ${l.cls}`} />)}
        {tags.map((l) => (
          <g key={l.label} className={`tc-tag ${l.cls}`}>
            <rect x={W - R + 2} y={l.ty - 9} width={R - 4} height={17} rx={3} />
            <text x={W - R + 6} y={l.ty + 4}>{price(l.y)}</text>
            <text x={W - R - 4} y={l.ty + 4} textAnchor="end" className="tc-tag-name">{l.label}</text>
          </g>
        ))}
        {increases.map((f, i) => {
          const sell = f.side === "SELL";
          return <Mark key={f.id} x={x(f.at)} y={y(Number(f.price))} down={sell} cls={i === 0 ? "m-entry" : "m-dca"} />;
        })}
        {fills.filter((f) => f.action === "decrease").map((f) => (
          <Mark key={f.id} x={x(f.at)} y={y(Number(f.price))} down={f.side === "SELL"} cls={Number(f.realized) >= 0 ? "m-win" : "m-loss"} size={10} />
        ))}
      </svg>
    );
  }

  const intervalMinutes = INTERVALS.find(([k]) => k === interval)[1];
  return (
    <div className="tc-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="tc-dialog" role="dialog" aria-modal="true" aria-label={`Сделка ${coin(cycle.symbol)}`}>
        <header className="tc-head">
          <h2>{coin(cycle.symbol)}<small>USDT</small></h2>
          <span className={`side ${short ? "short" : "long"}`}>{short ? "Шорт" : "Лонг"} ×{cycle.config.leverage}</span>
          <span className="chip">{entryLabel(cycle)}</span>
          <span className={`tc-status ${cycle.status === "CLOSED" ? "" : "live"}`}>{cycle.status === "CLOSED" ? CLOSE_REASON[cycle.closeReason] || "Закрыта" : "Открыта"}</span>
          <div className="seg tc-int" role="group" aria-label="Интервал свечей">
            {INTERVALS.slice(1).map(([k, m]) => <button key={k} aria-pressed={interval === k} onClick={() => setInterval_(k)}>{LABEL[m]}</button>)}
          </div>
          <button className="ghost icon tc-close" onClick={onClose} aria-label="Закрыть">✕</button>
        </header>

        <div className="tc-chart" ref={box}>
          {err ? <p className="banner">{err}</p> : !candles ? <p className="muted tc-wait">Загрузка свечей {LABEL[intervalMinutes]}…</p> : chart}
        </div>
        <ul className="tc-legend">
          <li><i className="lg-entry" />вход</li>
          <li><i className="lg-dca" />докупка</li>
          <li><i className={total >= 0 ? "lg-win" : "lg-loss"} />выход</li>
          <li><i className="lg-avg" />средняя</li>
          {cycle.status !== "CLOSED" && <li><i className="lg-pending" />следующие докупки</li>}
        </ul>

        <section className={`tc-result ${tone(total)}`}>
          <strong>{signed(total)}</strong>
          <span>{signed((total / budget) * 100, 2, "%")} от бюджета сделки ({money(budget, 0)})</span>
        </section>

        <dl className="tc-facts">
          <div><dt>Открыта</dt><dd>{when(cycle.openedAt)}</dd></div>
          <div><dt>{cycle.status === "CLOSED" ? "Закрыта" : "В сделке"}</dt><dd>{cycle.status === "CLOSED" ? when(cycle.closedAt) : duration(cycle.openedAt)}</dd></div>
          {cycle.status === "CLOSED" && <div><dt>Длилась</dt><dd>{duration(cycle.openedAt, cycle.closedAt)}</dd></div>}
          <div><dt><Hint term="anchor">Первый вход</Hint></dt><dd>{price(cycle.anchor)}</dd></div>
          <div><dt><Hint term="average">Средняя</Hint></dt><dd>{price(pos.average)}</dd></div>
          {exitPrice ? <div><dt>Выход</dt><dd>{price(exitPrice)}</dd></div> : <div><dt>Цена сейчас</dt><dd>{price(pos.mark)}</dd></div>}
          <div><dt><Hint term="steps">Шаги</Hint></dt><dd>{cycle.usedSteps} из {cycle.config.steps}</dd></div>
          <div><dt><Hint term="byPrice">По цене</Hint></dt><dd className={tone(total - Number(cycle.funding) + Number(cycle.fees))}>{signed(total - Number(cycle.funding) + Number(cycle.fees))}</dd></div>
          <div><dt><Hint term="funding">Фандинг</Hint></dt><dd className={tone(cycle.funding)}>{signed(cycle.funding, 3)}</dd></div>
          <div><dt><Hint term="fees">Комиссии</Hint></dt><dd>−{money(cycle.fees, 3)}</dd></div>
          <div><dt><Hint term="budget">Бюджет</Hint> × <Hint term="leverage">плечо</Hint></dt><dd>{money(budget, 0)} × {cycle.config.leverage}</dd></div>
          {Number(cycle.extraMargin) > 0 && <div><dt><Hint term="cushion">Подушка</Hint></dt><dd>{money(cycle.extraMargin)}</dd></div>}
        </dl>

        {fills.length > 0 && (
          <div className="table-wrap">
            <table className="grid-table compact">
              <thead><tr><th>Время</th><th>Действие</th><th className="num">Цена</th><th className="num">Объём</th><th className="num">Результат</th></tr></thead>
              <tbody>
                {fills.map((f, i) => (
                  <tr key={f.id}>
                    <td>{when(f.at)}</td>
                    <td>{f.action === "increase" ? (i === 0 ? "Вход" : "Докупка") : CLOSE_REASON[f.reason] || "Выход"}</td>
                    <td className="num">{price(f.price)}</td>
                    <td className="num">{money(Number(f.quantity) * Number(f.price))}</td>
                    <td className={`num ${f.action === "decrease" ? tone(f.realized) : ""}`}>{f.action === "decrease" ? signed(Number(f.realized) - Number(f.fee)) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
