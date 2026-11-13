// Сетевая политика: приложение ходит наружу только за публичными рыночными данными, только GET.
// Новые биржи добавляются в этот список явно.
const ALLOW = [
  { origin: "https://api.bybit.com", path: /^\/v5\/market\/(instruments-info|tickers|kline|funding\/history|mark-price-kline)$/ },
];

export async function guardedFetch(input, init = {}) {
  const u = new URL(String(input));
  const method = (init.method || "GET").toUpperCase();
  const rule = ALLOW.find((r) => r.origin === u.origin && r.path.test(u.pathname));
  if (!rule || method !== "GET" || init.body) throw Error(`Сетевой запрос запрещён политикой: ${method} ${u.origin}${u.pathname}`);
  return fetch(u, { signal: init.signal, redirect: "error" });
}
