// Пользователи и сессии: пароль — scrypt с солью, сессия — случайный токен в HttpOnly-cookie,
// в базе хранится только его SHA-256.
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { transaction } from "./db.js";

export const COOKIE = "vt_sid";
const SESSION_DAYS = 30;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;

export function migrateAuth(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, password TEXT NOT NULL, created_at INTEGER NOT NULL, settings TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY, id TEXT NOT NULL, user_id TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, expires INTEGER NOT NULL, agent TEXT NOT NULL DEFAULT '', ip TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS logins(id TEXT PRIMARY KEY, user_id TEXT, email TEXT NOT NULL, at INTEGER NOT NULL, ok INTEGER NOT NULL, agent TEXT NOT NULL DEFAULT '', ip TEXT NOT NULL DEFAULT '');`);
}

const sha = (s) => createHash("sha256").update(s).digest("hex");

function hashPassword(password) {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

function checkPassword(password, stored) {
  const [, salt, key] = stored.split("$");
  const got = scryptSync(password, Buffer.from(salt, "hex"), 64, { N: 16384, r: 8, p: 1 });
  const want = Buffer.from(key, "hex");
  return got.length === want.length && timingSafeEqual(got, want);
}

function validPassword(p) {
  if (typeof p !== "string" || p.length < 8 || p.length > 200) throw Error("Пароль — от 8 символов");
  if (!/[A-Za-zА-Яа-я]/.test(p) || !/\d/.test(p)) throw Error("В пароле нужны буквы и цифры");
}

export const publicUser = (u) => u && { id: u.id, email: u.email, name: u.name, createdAt: u.created_at, settings: JSON.parse(u.settings || "{}") };

export function userCount(db) {
  return db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
}

export function register(db, { email, name, password }) {
  email = String(email || "").trim().toLowerCase();
  name = String(name || "").trim();
  if (!EMAIL.test(email)) throw Error("Проверьте адрес почты");
  if (!name || name.length > 64) throw Error("Укажите имя (до 64 символов)");
  validPassword(password);
  return transaction(db, () => {
    if (db.prepare("SELECT 1 FROM users WHERE email=?").get(email)) throw Error("Этот адрес уже зарегистрирован — войдите");
    const first = userCount(db) === 0;
    const id = randomUUID();
    db.prepare("INSERT INTO users(id, email, name, password, created_at) VALUES(?,?,?,?,?)").run(id, email, name, hashPassword(password), Date.now());
    // Первый пользователь получает счета, перенесённые из VITrade 0.1.0.
    if (first) {
      for (const row of db.prepare("SELECT id, state FROM accounts").all()) {
        const a = JSON.parse(row.state);
        if (a.ownerId === "local" || !a.ownerId) {
          a.ownerId = id;
          db.prepare("UPDATE accounts SET state=?, revision=revision+1 WHERE id=?").run(JSON.stringify(a), row.id);
        }
      }
    }
    return id;
  });
}

const failures = new Map(); // ip -> [времена неудачных попыток]

export function login(db, { email, password }, meta) {
  email = String(email || "").trim().toLowerCase();
  const now = Date.now();
  const recent = (failures.get(meta.ip) || []).filter((t) => now - t < 15 * 6e4);
  if (recent.length >= 8) throw Object.assign(Error("Слишком много попыток. Подождите 15 минут"), { status: 429 });
  const u = db.prepare("SELECT * FROM users WHERE email=?").get(email);
  const ok = !!u && checkPassword(String(password || ""), u.password);
  recordLogin(db, u?.id || null, email, ok, meta);
  if (!ok) {
    failures.set(meta.ip, [...recent, now]);
    throw Object.assign(Error("Неверная почта или пароль"), { status: 401 });
  }
  failures.delete(meta.ip);
  return createSession(db, u.id, meta);
}

export function recordLogin(db, userId, email, ok, meta) {
  db.prepare("INSERT INTO logins VALUES(?,?,?,?,?,?,?)").run(randomUUID(), userId, email, Date.now(), ok ? 1 : 0, meta.agent.slice(0, 300), meta.ip);
}

export function createSession(db, userId, meta) {
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  db.prepare("INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?)").run(sha(token), randomUUID(), userId, now, now, now + SESSION_DAYS * 864e5, meta.agent.slice(0, 300), meta.ip);
  return token;
}

export function sessionUser(db, token) {
  if (!token) return null;
  const s = db.prepare("SELECT * FROM sessions WHERE hash=?").get(sha(token));
  if (!s || s.expires < Date.now()) return null;
  if (Date.now() - s.last_seen > 6e4) db.prepare("UPDATE sessions SET last_seen=? WHERE hash=?").run(Date.now(), s.hash);
  const u = db.prepare("SELECT * FROM users WHERE id=?").get(s.user_id);
  return u ? { user: u, session: s } : null;
}

export const logout = (db, token) => db.prepare("DELETE FROM sessions WHERE hash=?").run(sha(token || ""));

export function changePassword(db, user, current, next) {
  if (!checkPassword(String(current || ""), user.password)) throw Error("Текущий пароль указан неверно");
  validPassword(next);
  db.prepare("UPDATE users SET password=? WHERE id=?").run(hashPassword(next), user.id);
}

export function listSessions(db, userId, currentHash) {
  return db.prepare("SELECT * FROM sessions WHERE user_id=? AND expires>? ORDER BY last_seen DESC").all(userId, Date.now())
    .map((s) => ({ id: s.id, createdAt: s.created_at, lastSeen: s.last_seen, agent: s.agent, ip: s.ip, current: s.hash === currentHash }));
}

export const endSession = (db, userId, id) => db.prepare("DELETE FROM sessions WHERE user_id=? AND id=?").run(userId, id);
export const endOtherSessions = (db, userId, currentHash) => db.prepare("DELETE FROM sessions WHERE user_id=? AND hash<>?").run(userId, currentHash);

export const loginHistory = (db, userId) =>
  db.prepare("SELECT at, ok, agent, ip FROM logins WHERE user_id=? ORDER BY at DESC LIMIT 20").all(userId);

export function updateProfile(db, user, { name, settings }) {
  const n = name === undefined ? user.name : String(name).trim();
  if (!n || n.length > 64) throw Error("Укажите имя (до 64 символов)");
  const s = { ...JSON.parse(user.settings || "{}"), ...(settings && typeof settings === "object" ? settings : {}) };
  db.prepare("UPDATE users SET name=?, settings=? WHERE id=?").run(n, JSON.stringify(s).slice(0, 4000), user.id);
}
