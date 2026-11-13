import { pct, price } from "../format.js";

/**
 * Линейка позиции: цена ликвидации слева, дальше шаги сетки (закрашены набранные),
 * средняя, безубыток и текущая цена. Для шорта ось развёрнута, чтобы «опасность» всегда была слева.
 */
export default function Ruler({ p }) {
  const liq = Number(p.liquidation);
  const mark = Number(p.mark);
  const grid = (p.grid || []).map(Number);
  const pts = [liq, mark, Number(p.average), Number(p.breakEven), ...grid].filter((x) => Number.isFinite(x) && x > 0);
  if (!pts.length || !Number.isFinite(liq)) return null;
  const short = p.direction === "SHORT";
  let lo = Math.min(...pts);
  let hi = Math.max(...pts);
  const pad = (hi - lo) * 0.06 || hi * 0.01;
  lo -= pad;
  hi += pad;
  // x: 0 — сторона ликвидации, 1000 — безопасная
  const x = (v) => {
    const t = (v - lo) / (hi - lo);
    return (short ? 1 - t : t) * 1000;
  };
  const lr = Number(p.lr);
  const level = lr < 15 ? "danger" : lr < 30 ? "warn" : "safe";
  const xm = x(mark);
  return (
    <figure className={`ruler ${level}`}>
      <svg viewBox="0 0 1000 46" preserveAspectRatio="none" role="img"
        aria-label={`Запас до ликвидации ${pct(lr)}; ликвидация ${price(liq)}, цена ${price(mark)}`}>
        <rect className="r-zone" x={Math.min(x(liq), xm)} y="20" width={Math.abs(xm - x(liq))} height="6" />
        <line className="r-axis" x1="0" x2="1000" y1="23" y2="23" />
        {grid.map((g, i) => (
          <rect key={i} className={i < p.usedSteps ? "r-step used" : "r-step"} x={x(g) - 3} y="15" width="6" height="16" rx="1.5" />
        ))}
        <line className="r-liq" x1={x(liq)} x2={x(liq)} y1="8" y2="38" />
        <line className="r-be" x1={x(Number(p.breakEven))} x2={x(Number(p.breakEven))} y1="12" y2="34" />
        <path className="r-mark" d={`M${xm - 7} 4 L${xm + 7} 4 L${xm} 14 Z`} />
        <line className="r-mark-line" x1={xm} x2={xm} y1="14" y2="34" />
      </svg>
      <figcaption>
        <span className="r-l">ликвидация {price(liq)}</span>
        <span className="r-c">запас <b>{pct(lr)}</b></span>
        <span className="r-r">безубыток {price(p.breakEven)}</span>
      </figcaption>
    </figure>
  );
}
