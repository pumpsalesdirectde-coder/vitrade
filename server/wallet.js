// Кошелёк площадки и реферальная программа.
// Пока торговля виртуальная, кошелёк тоже виртуальный: пополнение — тестовое, без реальных денег.
// С каждой прибыльной закрытой сделки списывается комиссия площадки FEE_RATE от чистой прибыли;
// пригласивший получает REF_RATE от этой комиссии. При отрицательном балансе боты не открывают новые сделки.
import { randomBytes, randomUUID } from "node:crypto";
import { getValue, listAccounts, setValue, transaction } from "./db.js";

export const FEE_RATE = 0.2;
export const REF_RATE = 0.2;
export const WELCOME = 100;
const r2 = (n) => Math.round(n * 1e6) / 1e6;

export function migrateWallet(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS wallet_tx(id TEXT PRIMARY KEY, user_id TEXT NOT NULL, at INTEGER NOT NULL, type TEXT NOT NULL,
      amount REAL NOT NULL, note TEXT NOT NULL DEFAULT '', ref TEXT UNIQUE, meta TEXT NOT NULL DEFAULT '{}');
    CREATE INDEX IF NOT EXISTS wallet_tx_user ON wallet_tx(user_id, at);`);
  const cols = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
  if (!cols.includes("ref_code")) db.exec("ALTER TABLE users ADD COLUMN ref_code TEXT");
  if (!cols.includes("referred_by")) db.exec("ALTER TABLE users ADD COLUMN referred_by TEXT");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS users_ref_code ON users(ref_code)");
  // комиссия берётся только со сделок, закрытых после запуска кошелька
  if (!getValue(db, "billing:since", 0)) setValue(db, "billing:since", Date.now());
  for (const u of db.prepare("SELECT id FROM users").all()) ensureUser(db, u.id);
}

const addTx = (db, userId, type, amount, note, ref = null, meta = {}) =>
  db.prepare("INSERT OR IGNORE INTO wallet_tx(id, user_id, at, type, amount, note, ref, meta) VALUES(?,?,?,?,?,?,?,?)")
    .run(randomUUID(), userId, Date.now(), type, r2(amount), note, ref, JSON.stringify(meta)).changes > 0;

/** Код приглашения и приветственный виртуальный баланс. */
export function ensureUser(db, userId) {
  const u = db.prepare("SELECT ref_code FROM users WHERE id=?").get(userId);
  if (u && !u.ref_code) {
    for (let i = 0; i < 5; i++) {
      try {
        db.prepare("UPDATE users SET ref_code=? WHERE id=?").run(randomBytes(5).toString("base64url").replace(/[-_]/g, "x").slice(0, 7).toUpperCase(), userId);
        break;
      } catch { /* совпадение кода — пробуем другой */ }
    }
  }
  addTx(db, userId, "WELCOME", WELCOME, "Приветственный виртуальный баланс", `welcome:${userId}`);
}

/** Привязать нового пользователя к пригласившему по коду. */
export function attachReferrer(db, userId, code) {
  const c = String(code || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{4,12}$/.test(c)) return;
  const ref = db.prepare("SELECT id FROM users WHERE ref_code=?").get(c);
  if (ref && ref.id !== userId) db.prepare("UPDATE users SET referred_by=? WHERE id=? AND referred_by IS NULL").run(ref.id, userId);
}

export const balance = (db, userId) => r2(db.prepare("SELECT COALESCE(SUM(amount), 0) AS s FROM wallet_tx WHERE user_id=?").get(userId).s);

/** Списывает комиссию со всех новых прибыльных сделок и начисляет вознаграждение пригласившим. */
export function bill(db) {
  const since = getValue(db, "billing:since", Date.now());
  const users = new Map(db.prepare("SELECT id, referred_by, name FROM users").all().map((u) => [u.id, u]));
  let charged = 0;
  transaction(db, () => {
    for (const a of listAccounts(db, {snapshots: false})) {
      const owner = users.get(a.ownerId);
      if (!owner) continue;
      for (const c of a.cycles) {
        if (c.status !== "CLOSED" || !(c.closedAt >= since)) continue;
        const net = Number(c.realized) + Number(c.funding) - Number(c.fees);
        if (!(net > 0)) continue;
        const fee = net * FEE_RATE;
        const meta = { cycleId: c.id, symbol: c.symbol, account: a.name, profit: r2(net) };
        if (!addTx(db, owner.id, "FEE", -fee, `Комиссия ${FEE_RATE * 100}% с прибыли сделки ${c.symbol.replace(/USDT$/, "")}`, `fee:${c.id}`, meta)) continue;
        charged++;
        if (owner.referred_by && users.has(owner.referred_by)) {
          addTx(db, owner.referred_by, "REF", fee * REF_RATE, `Реферальное вознаграждение ${REF_RATE * 100}% с комиссии приглашённого`, `ref:${c.id}`,
            { ...meta, from: owner.id, fee: r2(fee) });
        }
      }
    }
  });
  return charged;
}

/** Пользователи с отрицательным балансом: их боты не открывают новых сделок. */
export const blockedUsers = (db) =>
  new Set(db.prepare("SELECT user_id FROM wallet_tx GROUP BY user_id HAVING SUM(amount) < 0").all().map((r) => r.user_id));

export function deposit(db, userId, amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n < 1 || n > 10000) throw Error("Сумма пополнения — от 1 до 10 000 $");
  const today = db.prepare("SELECT COALESCE(SUM(amount), 0) AS s FROM wallet_tx WHERE user_id=? AND type='DEPOSIT' AND at>?").get(userId, Date.now() - 864e5).s;
  if (today + n > 50000) throw Error("Тестовое пополнение — не больше 50 000 $ в сутки");
  addTx(db, userId, "DEPOSIT", n, "Тестовое пополнение (виртуальные деньги)", null);
}

export function walletView(db, userId) {
  const rows = db.prepare("SELECT at, type, amount, note, meta FROM wallet_tx WHERE user_id=? ORDER BY at DESC LIMIT 300").all(userId)
    .map((r) => ({ ...r, meta: JSON.parse(r.meta || "{}") }));
  const sum = (t) => r2(db.prepare("SELECT COALESCE(SUM(amount), 0) AS s FROM wallet_tx WHERE user_id=? AND type=?").get(userId, t).s);
  return {
    balance: balance(db, userId), feeRate: FEE_RATE, refRate: REF_RATE, virtual: true,
    totals: { deposits: sum("DEPOSIT") + sum("WELCOME"), fees: -sum("FEE"), referral: sum("REF") },
    tx: rows,
  };
}

export function referralView(db, userId) {
  ensureUser(db, userId);
  const me = db.prepare("SELECT ref_code FROM users WHERE id=?").get(userId);
  const invited = db.prepare("SELECT id, name, email, created_at FROM users WHERE referred_by=? ORDER BY created_at DESC").all(userId);
  const byUser = new Map(db.prepare("SELECT json_extract(meta, '$.from') AS u, COUNT(*) AS n, SUM(amount) AS s FROM wallet_tx WHERE user_id=? AND type='REF' GROUP BY u").all(userId).map((r) => [r.u, r]));
  const accounts = listAccounts(db, {snapshots: false});
  const mask = (e) => e.replace(/^(.{2}).*(@.*)$/, "$1•••$2");
  const list = invited.map((u) => {
    const r = byUser.get(u.id);
    const trades = accounts.filter((a) => a.ownerId === u.id).reduce((n, a) => n + a.cycles.filter((c) => c.status === "CLOSED").length, 0);
    return { name: u.name, email: mask(u.email), joinedAt: u.created_at, trades, active: trades > 0, rewards: r ? r2(r.s) : 0, paidTrades: r ? r.n : 0 };
  });
  return {
    code: me.ref_code, refRate: REF_RATE, feeRate: FEE_RATE,
    stats: { invited: list.length, active: list.filter((x) => x.active).length, earned: r2(list.reduce((s, x) => s + x.rewards, 0)) },
    invited: list,
  };
}
