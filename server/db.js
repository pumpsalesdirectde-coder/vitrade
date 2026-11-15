// Хранилище: SQLite (встроенный node:sqlite). Состояние счёта — один JSON-документ с ревизией.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { migrateSnapshots, appendSnapshots, readSnapshots, compactAccount, clearSnapshotCache } from './snapshots.js';

export function openDatabase(path) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY, position INTEGER NOT NULL, state TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS commands(account_id TEXT NOT NULL, key TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(account_id, key));`);
  try { transaction(db, () => migrateSnapshots(db)); }
  catch (e) { db.close(); throw e; }
  return db;
}

let savepointId = 0;
export function transaction(db, fn) {
  const savepoint = db.isTransaction ? `vitrade_${++savepointId}` : null;
  db.exec(savepoint ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE");
  try {
    const r = fn();
    db.exec(savepoint ? `RELEASE ${savepoint}` : "COMMIT");
    return r;
  } catch (e) {
    if (savepoint) { db.exec(`ROLLBACK TO ${savepoint}`); db.exec(`RELEASE ${savepoint}`); }
    else db.exec("ROLLBACK");
    clearSnapshotCache(db);
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

const hasSnapshotStorage = db => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='account_snapshots'").get();
const accountFromRow = (db, row, snapshots, separated = hasSnapshotStorage(db)) => {
  const a = JSON.parse(row.state);
  if (snapshots && separated) a.snapshots = readSnapshots(db, a.id, snapshots);
  return a;
};

export const listAccounts = (db, {snapshots = true} = {}) => {
  const separated = snapshots && hasSnapshotStorage(db);
  return db.prepare("SELECT state FROM accounts ORDER BY position").all().map(r => accountFromRow(db, r, snapshots, separated));
};

export function readAccount(db, id, {snapshots = true} = {}) {
  const row = db.prepare("SELECT state FROM accounts WHERE id=?").get(id);
  if (!row) throw Error("Счёт не найден");
  return accountFromRow(db, row, snapshots);
}

export function insertAccount(db, a) {
  return transaction(db, () => {
    const pos = db.prepare("SELECT COALESCE(MAX(position), 0) + 1 AS p FROM accounts").get().p;
    // Maintenance previews open legacy databases directly; preserve their format until startup migration.
    const separated = hasSnapshotStorage(db);
    db.prepare("INSERT INTO accounts(id, position, state) VALUES(?,?,?)").run(a.id, pos, JSON.stringify(separated ? compactAccount(a) : a));
    if (separated) appendSnapshots(db, a.id, a.snapshots);
  });
}

export function updateAccount(db, a, revision) {
  if (!db.isTransaction) throw Error('Обновление счёта требует транзакцию');
  const separated = hasSnapshotStorage(db);
  const result = db.prepare("UPDATE accounts SET state=?, revision=revision+1 WHERE id=? AND revision=?")
    .run(JSON.stringify(separated ? compactAccount(a) : a), a.id, revision);
  if (result.changes !== 1) throw Error('Счёт изменён другим запросом');
  if (separated) appendSnapshots(db, a.id, a.snapshots);
}

/** Изменить счёт атомарно. key — ключ идемпотентности: повтор той же команды ничего не делает. */
export function mutateAccount(db, id, fn, key) {
  return transaction(db, () => {
    const row = db.prepare("SELECT state, revision FROM accounts WHERE id=?").get(id);
    if (!row) throw Error("Счёт не найден");
    if (key && db.prepare("SELECT 1 FROM commands WHERE account_id=? AND key=?").get(id, key)) return JSON.parse(row.state);
    const a = JSON.parse(row.state);
    const result = fn(a);
    updateAccount(db, a, row.revision);
    if (key) db.prepare("INSERT INTO commands VALUES(?,?,?)").run(id, key, Date.now());
    return result ?? a;
  });
}
