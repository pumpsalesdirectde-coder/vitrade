/** Логотип MIVTrade: знак MIV с волной и надписью (картинка из web/public). */
export default function Brand({ size = 26 }) {
  // size — прежний размер знака; логотип с надписью примерно в 5 раз шире
  const width = Math.round(size * 5);
  return (
    <span className="brand">
      <img src="/logo-full.png" width={width} alt="MIVTrade" />
    </span>
  );
}
