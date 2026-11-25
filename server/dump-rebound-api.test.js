import { test } from "node:test";
import assert from "node:assert/strict";
import { createApi } from "./http.js";
import { insertAccount, openDatabase, readAccount } from "./db.js";
import { gridPrice, newAccount } from "./engine/engine.js";
import { applyDumpReboundPreset } from "../web/src/dump-rebound-preset.js";
import * as auth from "./auth.js";

test("ordinary create-bot API stores the DUMP rebound preset without starting it", async () => {
  const db = openDatabase(":memory:");
  auth.migrateAuth(db);
  const ownerId = auth.register(db, { email: "rebound@example.test", name: "Rebound", password: "test12345" });
  const account = newAccount("rebound-account", ownerId, "Rebound test", "market", 0);
  insertAccount(db, account);
  const token = auth.createSession(db, ownerId, { agent: "test", ip: "127.0.0.1" });
  const server = createApi({ db, fetcher: () => { throw Error("offline test"); }, webRoot: process.cwd(), port: 0 });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const config = applyDumpReboundPreset({ name: "Bot", fork: { enabled: true } }, [
      "RSI_SHORT", "RSI_LONG", "PUMP", "EARLY", "FLIP", "FLIP_RISK", "DUMP", "DUMP_ACCEL", "DUMP_REBOUND", "CRASH",
    ]);
    const response = await fetch(`${base}/api/accounts/${account.id}/bots`, {
      method: "POST",
      headers: { "x-vitrade": "1", "content-type": "application/json", cookie: `${auth.COOKIE}=${token}` },
      body: JSON.stringify({ config, start: false }),
    });
    assert.equal(response.status, 200);
    const { id } = await response.json();
    const stored = readAccount(db, account.id);
    const bot = stored.bots.find((candidate) => candidate.id === id);
    assert.ok(bot);
    assert.equal(bot.enabled, false);
    assert.equal(bot.config.name, "DUMP SHORT — тейк 2,5% и выход 50% при восстановлении");
    assert.equal(bot.config.stages.DUMP_REBOUND, true);
    assert.equal(bot.config.stages.DUMP_ACCEL, false);
    assert.equal(bot.config.tpPct, "2.5");
    assert.equal(bot.config.recoveryExitOn, true);
    assert.equal(bot.config.recoveryArmStep, 4);
    assert.equal(bot.config.recoveryArmNet, "-75");
    assert.equal(bot.config.recoveryTargetNet, "-10");
    assert.equal(bot.config.recoveryExitPct, "50");
    assert.equal(bot.config.fork.enabled, false);
    assert.equal(stored.cycles.length, 0);
    assert.equal(stored.fills.length, 0);

    const update = await fetch(`${base}/api/accounts/${account.id}/bots/${id}/commands`, {
      method: "POST",
      headers: { "x-vitrade": "1", "content-type": "application/json", cookie: `${auth.COOKIE}=${token}` },
      body: JSON.stringify({ action: "update", payload: { ...bot.config, spacingPct: "3.25" } }),
    });
    assert.equal(update.status, 200);
    const edited = readAccount(db, account.id).bots.find((candidate) => candidate.id === id);
    assert.equal(edited.enabled, false);
    assert.equal(edited.config.spacingPct, "3.25");
    assert.equal(edited.config.entryPct, "12.5");
    assert.equal(gridPrice({ direction: "SHORT", anchor: "100", config: edited.config }, 7).toString(), "122.75");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});
