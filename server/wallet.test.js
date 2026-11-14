import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, insertAccount } from "./db.js";
import * as auth from "./auth.js";
import * as wallet from "./wallet.js";
import { newAccount } from "./engine/engine.js";

test("комиссия 20% с прибыли, 20% от неё пригласившему, блокировка при минусе", () => {
  const db = openDatabase(":memory:");
  auth.migrateAuth(db);
  wallet.migrateWallet(db);
  const boss = auth.register(db, { email: "boss@x.io", name: "Босс", password: "secret123" });
  wallet.ensureUser(db, boss);
  const code = wallet.referralView(db, boss).code;
  const guest = auth.register(db, { email: "guest@x.io", name: "Гость", password: "secret123" });
  wallet.attachReferrer(db, guest, code);
  wallet.ensureUser(db, guest);
  assert.equal(wallet.balance(db, guest), wallet.WELCOME);

  const a = newAccount("acc", guest, "Счёт", "market", 0);
  const closed = (id, realized) => ({ id, symbol: "XUSDT", status: "CLOSED", closedAt: Date.now() + 1000, realized, funding: "0", fees: "0" });
  a.cycles.push(closed("c1", "1000"), closed("c2", "-50"));
  insertAccount(db, a);
  assert.equal(wallet.bill(db), 1);
  assert.equal(wallet.bill(db), 0); // повторно не списывается
  assert.equal(wallet.balance(db, guest), wallet.WELCOME - 200);
  assert.equal(wallet.balance(db, boss), wallet.WELCOME + 40);
  assert.ok(wallet.blockedUsers(db).has(guest));
  wallet.deposit(db, guest, 150);
  assert.ok(!wallet.blockedUsers(db).has(guest));
  const r = wallet.referralView(db, boss);
  assert.equal(r.stats.invited, 1);
  assert.equal(r.stats.earned, 40);
});
