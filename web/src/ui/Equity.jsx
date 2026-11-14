import { money } from "../format.js";

/** Кривая капитала счёта с линией стартового капитала. */
export default function Equity({ points, initial }) {
  const data = (points || []).map((p) => [p.at, Number(p.equity)]).filter(([, v]) => Number.isFinite(v));
  if (data.length < 2) return <div className="equity empty muted">График появится через несколько минут работы</div>;
  const base = Number(initial);
  const t0 = data[0][0];
  const t1 = data.at(-1)[0];
  const vals = data.map(([, v]) => v).concat(base);
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  const pad = (hi - lo) * 0.12 || 1;
  lo -= pad;
  hi += pad;
  const W = 600;
  const H = 120;
  const X = (t) => ((t - t0) / (t1 - t0 || 1)) * W;
  const Y = (v) => H - ((v - lo) / (hi - lo)) * H;
  const line = data.map(([t, v], i) => `${i ? "L" : "M"}${X(t).toFixed(1)} ${Y(v).toFixed(1)}`).join(" ");
  const last = data.at(-1)[1];
  return (
    <figure className="equity">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`Капитал ${money(last)}`}>
        <line className="eq-base" x1="0" x2={W} y1={Y(base)} y2={Y(base)} />
        <path className={`eq-line ${last >= base ? "up" : "down"}`} d={line} vectorEffect="non-scaling-stroke" />
      </svg>
      <figcaption className="muted">
        <span>{new Date(t0).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>
        <span>пунктир — стартовый капитал {money(base, 0)}</span>
        <span>сейчас</span>
      </figcaption>
    </figure>
  );
}
