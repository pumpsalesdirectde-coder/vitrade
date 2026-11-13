// Копирует счета, ботов и сделки из базы VITrade 0.1.0 в базу этого приложения.
// Старая база открывается только на чтение. Уже импортированные счета пропускаются.
// Запуск: npm run import -- "<путь к vitrade.sqlite>"
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { getValue, insertAccount, openDatabase, setValue } from "../server/db.js";
import { STRATEGY_KEYS } from "../server/engine/signals.js";

const src = process.argv[2] || "D:/Project/VITrade-run/VITrade-0.1.0-Windows-x64-2026-11-11T22-51-17-513Z/VITrade/data/vitrade.sqlite";
const dst = process.env.VITRADE_DB || resolve("data", "vitrade.sqlite");
const old = new DatabaseSync(src, { readOnly: true });
const db = openDatabase(dst);

function normalizeConfig(c) {
  const mode = c.mode === "manual" ? "manual" : "auto";
  const st = c.stages || (c.mode === "stages" ? { EARLY: true, FLIP: true, DUMP: true } : { ["RSI_" + c.direction]: true });
  return { ...c, mode, stages: Object.fromEntries(STRATEGY_KEYS.map((k) => [k, st[k] === true])) };
}

let added = 0;
for (const row of old.prepare("SELECT state FROM accounts ORDER BY rowid").all()) {
  const a = JSON.parse(row.state);
  if (db.prepare("SELECT 1 FROM accounts WHERE id=?").get(a.id)) {
    console.log("уже есть:", a.name);
    continue;
  }
  a.ownerId = "local";
  a.exchange = a.exchange || "bybit";
  for (const b of a.bots) b.config = normalizeConfig(b.config);
  for (const c of a.cycles) c.config = normalizeConfig(c.config);
  insertAccount(db, a);
  added++;
  console.log("импортирован:", a.name, `(${a.bots.length} ботов, ${a.cycles.length} сделок)`);
}
for (const key of ["market:schedules", "market:fundingDue", "market:funding"]) {
  const row = old.prepare("SELECT value FROM kv WHERE key=?").get(key);
  if (row && getValue(db, key, null) === null) setValue(db, key, JSON.parse(row.value));
}
console.log(`готово: добавлено счетов ${added}`);
