import { test } from "node:test";
import assert from "node:assert/strict";
import { insertAccount, listAccounts, openDatabase } from "./db.js";
import { newAccount } from "./engine/engine.js";
import * as auth from "./auth.js";

const meta = { ip: "127.0.0.1", agent: "test" };

test("первый пользователь забирает перенесённые счета; вход и смена пароля", () => {
  const db = openDatabase(":memory:");
  auth.migrateAuth(db);
  insertAccount(db, newAccount("acc1", "local", "Старый", "market", 0));
  const id = auth.register(db, { email: "A@B.io", name: "Иван", password: "secret123" });
  assert.equal(listAccounts(db)[0].ownerId, id);
  assert.throws(() => auth.register(db, { email: "a@b.io", name: "X", password: "secret123" }), /уже зарегистрирован/);
  assert.throws(() => auth.login(db, { email: "a@b.io", password: "wrong1234" }, meta), /Неверная/);
  const token = auth.login(db, { email: "a@b.io", password: "secret123" }, meta);
  const s = auth.sessionUser(db, token);
  assert.equal(s.user.id, id);
  auth.changePassword(db, s.user, "secret123", "newpass456");
  assert.ok(auth.login(db, { email: "a@b.io", password: "newpass456" }, meta));
  auth.logout(db, token);
  assert.equal(auth.sessionUser(db, token), null);
});

test("второй пользователь чужие счета не получает", () => {
  const db = openDatabase(":memory:");
  auth.migrateAuth(db);
  auth.register(db, { email: "one@x.io", name: "Один", password: "secret123" });
  insertAccount(db, newAccount("acc2", "local", "Ничей", "market", 0));
  auth.register(db, { email: "two@x.io", name: "Два", password: "secret123" });
  assert.equal(listAccounts(db)[0].ownerId, "local");
});
