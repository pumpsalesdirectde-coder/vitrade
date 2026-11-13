/** Знак VITrade: три наклонных столбика разной высоты, как в первой версии. */
export function BrandMark({ size = 26 }) {
  return (
    <svg className="brand-mark" viewBox="0 0 30 30" width={size} height={size} aria-hidden="true">
      <g transform="skewX(-14) translate(5 0)">
        <rect x="2" y="13" width="6" height="15" rx="1.2" />
        <rect x="11" y="2" width="6" height="26" rx="1.2" />
        <rect x="20" y="8" width="6" height="20" rx="1.2" />
      </g>
    </svg>
  );
}

export default function Brand({ size }) {
  return (
    <span className="brand">
      <BrandMark size={size} />
      <span>VI<b>Trade</b></span>
    </span>
  );
}
