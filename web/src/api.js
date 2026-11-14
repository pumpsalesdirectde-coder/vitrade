import { useCallback, useEffect, useRef, useState } from "react";

const onUnauthorized = new Set();

async function call(path, init) {
  const res = await fetch(path, { credentials: "same-origin", ...init });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith("/api/auth/")) onUnauthorized.forEach((f) => f());
  if (!res.ok) throw Error(body.error || `Ошибка ${res.status}`);
  return body;
}

export const get = (path) => call(path);
export const post = (path, data = {}) =>
  call(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-vitrade": "1", "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify(data),
  });

/** Текущий пользователь; null — не вошёл. */
export function useSession() {
  const [session, setSession] = useState(undefined);
  const load = useCallback(() => get("/api/session").then(setSession).catch(() => setSession({ user: null, offline: true })), []);
  useEffect(() => {
    load();
    const f = () => setSession((s) => ({ ...s, user: null }));
    onUnauthorized.add(f);
    return () => onUnauthorized.delete(f);
  }, [load]);
  return [session, load];
}

/** Состояние счетов с опросом сервера; refresh() — обновить сразу после команды. */
export function useAppState(enabled, intervalMs = 2000) {
  const [state, setState] = useState(null);
  const [error, setError] = useState("");
  const timer = useRef(0);
  const load = useCallback(async () => {
    try {
      setState(await get("/api/state"));
      setError("");
    } catch (e) {
      setError(e.message === "Failed to fetch" ? "Нет связи с сервером MIVTrade" : e.message);
    }
  }, []);
  useEffect(() => {
    if (!enabled) return undefined;
    load();
    timer.current = setInterval(load, intervalMs);
    return () => clearInterval(timer.current);
  }, [enabled, intervalMs, load]);
  return { state, error, refresh: load };
}

/** Однократная загрузка с периодическим обновлением. */
export function usePoll(path, intervalMs = 10000) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const load = useCallback(() => get(path).then((d) => { setData(d); setError(""); }).catch((e) => setError(e.message)), [path]);
  useEffect(() => {
    load();
    const t = setInterval(load, intervalMs);
    return () => clearInterval(t);
  }, [load, intervalMs]);
  return { data, error, reload: load };
}
