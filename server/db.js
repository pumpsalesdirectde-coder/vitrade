// Хранилище: SQLite (встроенный node:sqlite). Состояние счёта — один JSON-документ с ревизией.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function openDatabase(path) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY, position INTEGER NOT NULL, state TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS commands(account_id TEXT NOT NULL, key TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(account_id, key));`);
  return db;
}

export function transaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function getValue(db, key, fallback) {
  const row = db.prepare("SELECT value FROM kv WHERE key=?").get(key);
  return row ? JSON.parse(row.value) : fallback;
}

export function setValue(db, key, value) {
  db.prepare("INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, JSON.stringify(value));
}

export const listAccounts = (db) =>
  db.prepare("SELECT state FROM accounts ORDER BY position").all().map((r) => JSON.parse(r.state));

export function readAccount(db, id) {
  const row = db.prepare("SELECT state FROM accounts WHERE id=?").get(id);
  if (!row) throw Error("Счёт не найден");
  return JSON.parse(row.state);
}

export function insertAccount(db, a) {
  const pos = db.prepare("SELECT COALESCE(MAX(position), 0) + 1 AS p FROM accounts").get().p;
  db.prepare("INSERT INTO accounts(id, position, state) VALUES(?,?,?)").run(a.id, pos, JSON.stringify(a));
}

/** Изменить счёт атомарно. key — ключ идемпотентности: повтор той же команды ничего не делает. */
export function mutateAccount(db, id, fn, key) {
  return transaction(db, () => {
    const row = db.prepare("SELECT state, revision FROM accounts WHERE id=?").get(id);
    if (!row) throw Error("Счёт не найден");
    if (key && db.prepare("SELECT 1 FROM commands WHERE account_id=? AND key=?").get(id, key)) return JSON.parse(row.state);
    const a = JSON.parse(row.state);
    const result = fn(a);
    db.prepare("UPDATE accounts SET state=?, revision=revision+1 WHERE id=? AND revision=?").run(JSON.stringify(a), id, row.revision);
    if (key) db.prepare("INSERT INTO commands VALUES(?,?,?)").run(id, key, Date.now());
    return result ?? a;
  });
}
