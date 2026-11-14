// HTTP API и раздача собранного интерфейса. Слушает только 127.0.0.1.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { randomUUID } from "node:crypto";
import { getValue, insertAccount, listAccounts, mutateAccount, readAccount, transaction } from "./db.js";
import { DEFAULT_CONFIG, LIMITS, command, createBot, newAccount, summarize } from "./engine/engine.js";
import { D, positive } from "./engine/accounting.js";
import { forkPlan } from './engine/fork.js';
import { collectCandles } from "./market/bybit.js";
import * as auth from "./auth.js";
import * as wallet from "./wallet.js";

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".woff": "font/woff", ".png": "image/png", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json", ".json": "application/json" };
const fail = (message, status = 400) => Object.assign(Error(message), { status });

function thin(points, n = 240) {
  if (points.length <= n) return points;
  const step = points.length / n;
  return Array.from({ length: n }, (_, i) => points[Math.floor(i * step)]).concat(points.at(-1));
}

function publicAccount(a, quotes) {
  const s = summarize(a, quotes);
  const { fills, fundingIds, ...rest } = s;
  // служебная история цен подстраховки интерфейсу не нужна
  const strip = ({ marks, forkMarks, ...c }) => c;
  return { ...rest, cycles: rest.cycles.map(strip), positions: rest.positions.map(strip), snapshots: thin(s.snapshots), events: s.events.slice(-150).reverse(), fillCount: fills.length };
}

async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const ch of req) {
    size += ch.length;
    if (size > 65536) throw fail("Слишком большой запрос", 413);
    chunks.push(ch);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw fail("Некорректный JSON");
  }
}

const cookies = (req) => Object.fromEntries((req.headers.cookie || "").split(/;\s*/).filter(Boolean).map((p) => {
  const i = p.indexOf("=");
  return [p.slice(0, i), decodeURIComponent(p.slice(i + 1))];
}));
export function createApi({ db, fetcher, webRoot, port, publicUrl = "", trustProxy = false, maxUsers = 0 }) {
  auth.migrateAuth(db);
  wallet.migrateWallet(db);
  const secure = publicUrl.startsWith("https://");
  const sessionCookie = (token, maxAge) => `${auth.COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
  const origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, "http://127.0.0.1:5173", "http://localhost:5173"]);
  if (publicUrl) origins.add(publicUrl);
  const signups = new Map(); // ip -> времена регистраций, не больше 5 в час
  const startedAt = Date.now();
  const own = (user, id) => {
    const a = readAccount(db, id);
    if (a.ownerId !== user.id) throw fail("Счёт не найден", 404);
    return a;
  };
  const mutateOwn = (user, id, fn, key) => {
    own(user, id);
    return mutateAccount(db, id, fn, key);
  };

  // [метод, путь, обработчик, нужен ли вход]
  const routes = [
    ["GET", /^\/api\/health$/, () => ({ ok: true, uptime: Math.round((Date.now() - startedAt) / 1000), market: getValue(db, "market:health", {}).status || "starting" }), false],
    ["GET", /^\/api\/session$/, (ctx) => ({ user: auth.publicUser(ctx.user), firstRun: auth.userCount(db) === 0 }), false],
    ["POST", /^\/api\/auth\/register$/, async (ctx) => {
      const p = await body(ctx.req);
      const now = Date.now();
      const recent = (signups.get(ctx.meta.ip) || []).filter((t) => now - t < 36e5);
      if (recent.length >= 5) throw fail("Слишком много регистраций с этого адреса. Попробуйте через час", 429);
      if (maxUsers && auth.userCount(db) >= maxUsers) throw fail("Набор на тест закрыт: мест больше нет", 403);
      const id = auth.register(db, p);
      signups.set(ctx.meta.ip, [...recent, now]);
      wallet.attachReferrer(db, id, p.ref);
      wallet.ensureUser(db, id);
      // Новичку сразу открываем виртуальный счёт, чтобы кабинет не был пустым.
      if (!listAccounts(db).some((a) => a.ownerId === id)) insertAccount(db, newAccount(randomUUID(), id, "Основной счёт", "market", now, "bybit", "10000"));
      auth.recordLogin(db, id, String(p.email).trim().toLowerCase(), true, ctx.meta);
      ctx.setCookie = sessionCookie(auth.createSession(db, id, ctx.meta), 30 * 86400);
      return { ok: true };
    }, false],
    ["POST", /^\/api\/auth\/login$/, async (ctx) => {
      const p = await body(ctx.req);
      ctx.setCookie = sessionCookie(auth.login(db, p, ctx.meta), 30 * 86400);
      return { ok: true };
    }, false],
    ["POST", /^\/api\/auth\/logout$/, (ctx) => {
      auth.logout(db, ctx.token);
      ctx.setCookie = sessionCookie("", 0);
      return { ok: true };
    }, false],
    ["POST", /^\/api\/auth\/password$/, async (ctx) => {
      const p = await body(ctx.req);
      auth.changePassword(db, ctx.user, p.current, p.next);
      auth.endOtherSessions(db, ctx.user.id, ctx.session.hash);
      return { ok: true };
    }],
    ["GET", /^\/api\/security$/, (ctx) => ({
      sessions: auth.listSessions(db, ctx.user.id, ctx.session.hash),
      logins: auth.loginHistory(db, ctx.user.id),
    })],
    ["POST", /^\/api\/security\/sessions\/end-others$/, (ctx) => {
      auth.endOtherSessions(db, ctx.user.id, ctx.session.hash);
      return { ok: true };
    }],
    ["POST", /^\/api\/security\/sessions\/([\w-]+)\/end$/, (ctx, m) => {
      auth.endSession(db, ctx.user.id, m[1]);
      return { ok: true };
    }],
    ["POST", /^\/api\/profile$/, async (ctx) => {
      auth.updateProfile(db, ctx.user, await body(ctx.req));
      return { ok: true };
    }],
    ["GET", /^\/api\/wallet$/, (ctx) => wallet.walletView(db, ctx.user.id)],
    ["POST", /^\/api\/wallet\/deposit$/, async (ctx) => {
      wallet.deposit(db, ctx.user.id, (await body(ctx.req)).amount);
      return { ok: true };
    }],
    ["GET", /^\/api\/referrals$/, (ctx) => wallet.referralView(db, ctx.user.id)],
    ["GET", /^\/api\/state$/, (ctx) => {
      const quotes = getValue(db, "market:quotes", {});
      return {
        now: Date.now(), limits: LIMITS, defaults: DEFAULT_CONFIG,
        market: getValue(db, "market:health", { status: "starting" }),
        worker: getValue(db, "worker:health", { status: "starting" }),
        wallet: { balance: wallet.balance(db, ctx.user.id) },
        accounts: listAccounts(db).filter((a) => a.ownerId === ctx.user.id).map((a) => publicAccount(a, quotes)),
      };
    }],
    ["GET", /^\/api\/market$/, () => ({
      health: getValue(db, "market:health", {}),
      quotes: Object.values(getValue(db, "market:quotes", {})).sort((a, b) => Number(b.turnover) - Number(a.turnover)),
    })],
    ["GET", /^\/api\/candles$/, async (_ctx, _m, url) => {
      const symbol = url.searchParams.get("symbol") || "";
      const interval = url.searchParams.get("interval") || "15";
      if (!/^[A-Z0-9]{1,24}USDT$/.test(symbol) || !["1", "5", "15", "60", "240", "D"].includes(interval)) throw fail("Неверная монета или интервал");
      const limit = Math.min(1000, Math.max(20, Number(url.searchParams.get("limit")) || 200));
      const end = Number(url.searchParams.get("end")) || 0;
      if (end && (end < 1.5e12 || end > Date.now() + 864e5)) throw fail("Неверная дата");
      return { symbol, interval, candles: await collectCandles(fetcher, symbol, interval, limit, end) };
    }],
    ["POST", /^\/api\/accounts$/, async (ctx) => {
      const p = await body(ctx.req);
      const name = String(p.name || "").trim();
      const initial = String(p.initial || "10000");
      if (!name || name.length > 64) throw fail("Укажите название счёта (до 64 символов)");
      if (!positive(initial) || D(initial).gt(1e8)) throw fail("Стартовый капитал — положительное число до 100 млн");
      if ((p.exchange || "bybit") !== "bybit") throw fail("Пока доступны только счета на ценах Bybit");
      return transaction(db, () => {
        const active = listAccounts(db).filter((a) => a.ownerId === ctx.user.id && !a.archived);
        if (active.length >= LIMITS.accounts) throw fail(`Можно держать до ${LIMITS.accounts} активных счетов`);
        const a = newAccount(randomUUID(), ctx.user.id, name, "market", Date.now(), "bybit", D(initial).toFixed());
        insertAccount(db, a);
        return { id: a.id };
      });
    }],
    ["POST", /^\/api\/accounts\/([\w-]+)\/(archive|restore|rename)$/, async (ctx, m) => {
      const p = await body(ctx.req);
      mutateOwn(ctx.user, m[1], (a) => {
        if (m[2] === "rename") {
          const name = String(p.name || "").trim();
          if (!name || name.length > 64) throw fail("Укажите название счёта");
          a.name = name;
        } else {
          if (m[2] === "archive" && a.cycles.some((c) => c.status !== "CLOSED")) throw fail("Сначала закройте открытые позиции");
          a.archived = m[2] === "archive";
          if (a.archived) for (const b of a.bots) b.enabled = false;
        }
      });
      return { ok: true };
    }],
    ["POST", /^\/api\/accounts\/([\w-]+)\/bots$/, async (ctx, m) => {
      const p = await body(ctx.req);
      const id = mutateOwn(ctx.user, m[1], (a) => {
        const b = createBot(a, { ...DEFAULT_CONFIG, ...p.config }, Date.now());
        if (p.start) command(a, b.id, "start", {}, Date.now());
        return b.id;
      }, ctx.req.headers["idempotency-key"]);
      return { id };
    }],
    ["POST", /^\/api\/accounts\/([\w-]+)\/bots\/([\w-]+)\/fork-preview$/, async (ctx, m) => {
      const a = own(ctx.user, m[1]);
      const b = a.bots.find(b => b.id === m[2]);
      if (!b || b.forkParentId) throw fail('Основной бот не найден', 404);
      const p = await body(ctx.req);
      const c = a.cycles.find(c => c.id === b.currentCycleId);
      if (c?.forkId) return { ok: false, reason: 'Вилка уже открыта; её параметры зафиксированы' };
      return forkPlan(a, b, c, c && getValue(db, 'market:quotes', {})[c.symbol], Date.now(), p.settings);
    }],
    ["POST", /^\/api\/accounts\/([\w-]+)\/bots\/([\w-]+)\/commands$/, async (ctx, m) => {
      const p = await body(ctx.req);
      mutateOwn(ctx.user, m[1], (a) => command(a, m[2], p.action, p.payload || {}, Date.now()), ctx.req.headers["idempotency-key"]);
      return { ok: true };
    }],
    ["POST", /^\/api\/accounts\/([\w-]+)\/bots\/([\w-]+)\/delete$/, (ctx, m) => {
      mutateOwn(ctx.user, m[1], (a) => {
        const b = a.bots.find((x) => x.id === m[2]);
        if (!b) throw fail("Бот не найден", 404);
        if (b.currentCycleId) throw fail("У бота открыта позиция — сначала закройте её");
        a.bots = a.bots.filter((x) => x.id !== m[2]);
      });
      return { ok: true };
    }],
    ["GET", /^\/api\/accounts\/([\w-]+)\/fills$/, (ctx, m) => own(ctx.user, m[1]).fills.slice(-3000)],
  ];

  async function serveStatic(res, pathname) {
    const safe = normalize(decodeURIComponent(pathname)).replace(/^([\\/.])+/, "");
    let file = join(webRoot, safe);
    if (!file.startsWith(webRoot)) file = join(webRoot, "index.html");
    try {
      if (!(await stat(file)).isFile()) throw 0;
    } catch {
      // отсутствующий файл (например, старый /icon.svg) — 404, а не страница: иначе браузер кэширует HTML как иконку
      if (extname(safe)) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-cache" });
        return res.end("Not found");
      }
      file = join(webRoot, "index.html");
    }
    try {
      const data = await readFile(file);
      res.writeHead(200, {
        "content-type": TYPES[extname(file)] || "application/octet-stream",
        "cache-control": file.includes(join("assets", "")) ? "public, max-age=31536000, immutable" : "no-cache",
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
      });
      res.end(data);
    } catch {
      res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
      res.end("Интерфейс не собран: выполните npm run build");
    }
  }

  return createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (!url.pathname.startsWith("/api/")) return serveStatic(res, url.pathname);
    const send = (status, data, cookie) => {
      const h = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
      if (cookie) h["set-cookie"] = cookie;
      res.writeHead(status, h);
      res.end(JSON.stringify(data));
    };
    // POST только со своего адреса и с заголовком приложения — защита от запросов с чужих сайтов.
    if (req.method === "POST") {
      const origin = req.headers.origin;
      const okOrigin = !origin || origins.has(origin);
      if (!okOrigin || req.headers["x-vitrade"] !== "1") return send(403, { error: "Запрос отклонён" });
    }
    const token = cookies(req)[auth.COOKIE];
    const found = auth.sessionUser(db, token);
    const ctx = {
      req, token, user: found?.user || null, session: found?.session || null,
      // За прокси хостинга настоящий адрес клиента — первый в x-forwarded-for.
      meta: { ip: (trustProxy && String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()) || req.socket.remoteAddress || "", agent: String(req.headers["user-agent"] || "") },
    };
    for (const [method, re, fn, needsUser = true] of routes) {
      const m = url.pathname.match(re);
      if (!m || req.method !== method) continue;
      if (needsUser && !ctx.user) return send(401, { error: "Войдите в аккаунт" });
      try {
        return send(200, await fn(ctx, m, url), ctx.setCookie);
      } catch (e) {
        return send(e.status || 400, { error: e.message });
      }
    }
    send(404, { error: "Не найдено" });
  });
}
