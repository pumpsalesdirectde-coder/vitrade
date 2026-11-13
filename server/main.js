// Точка входа: база, фоновый движок и HTTP-сервер в одном процессе.
// Локально слушает 127.0.0.1:4180. На хостинге (Render) задаются PORT, VITRADE_HOST=0.0.0.0,
// VITRADE_PUBLIC_URL и VITRADE_DB на постоянном диске.
import { mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "./db.js";
import { startRunner } from "./runner.js";
import { createApi } from "./http.js";
import { guardedFetch } from "./net.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const env = process.env;
const port = Number(env.PORT || env.VITRADE_PORT || 4180);
const host = env.VITRADE_HOST || "127.0.0.1";
const dbPath = env.VITRADE_DB || resolve(root, "data", "vitrade.sqlite");
mkdirSync(dirname(dbPath), { recursive: true });

const db = openDatabase(dbPath);
const stop = startRunner(db, guardedFetch, { offline: env.VITRADE_OFFLINE === "1" });
const server = createApi({
  db, fetcher: guardedFetch, webRoot: resolve(root, "web", "dist"), port,
  publicUrl: (env.VITRADE_PUBLIC_URL || env.RENDER_EXTERNAL_URL || "").replace(/\/$/, ""),
  trustProxy: env.VITRADE_TRUST_PROXY === "1" || !!env.RENDER,
  maxUsers: Number(env.VITRADE_MAX_USERS || 0),
});

server.listen(port, host, () => console.log(`VITrade: http://${host}:${port}`));

function shutdown() {
  stop();
  server.close();
  setTimeout(() => {
    db.close();
    process.exit(0);
  }, 300);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
