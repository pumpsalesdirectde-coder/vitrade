import assert from "node:assert/strict";
import test from "node:test";
import * as auth from "./auth.js";
import { openDatabase, insertAccount, readAccount } from "./db.js";
import { newAccount } from "./engine/engine.js";
import { createApi } from "./http.js";
import { createRangePaperService } from "./range-paper/service.js";

test("the Range PAPER book is off by default and can only be changed by its signed-in owner", async () => {
  const db = openDatabase(":memory:");
  auth.migrateAuth(db);
  const first = auth.register(db, { email: "first@example.test", name: "First", password: "test12345" });
  const second = auth.register(db, { email: "second@example.test", name: "Second", password: "test12345" });
  const regular = newAccount("ordinary", first, "Existing", "market", 0);
  insertAccount(db, regular);
  const original = readAccount(db, regular.id);
  const fetcher = () => { throw Error("This test has no market access"); };
  const rangePaper = createRangePaperService(db, { fetcher, offline: true });
  const server = createApi({ db, fetcher, webRoot: process.cwd(), port: 0, rangePaper });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const url = `http://127.0.0.1:${server.address().port}/api/range-paper`;
  const sessionFor = owner => `${auth.COOKIE}=${auth.createSession(db, owner, { ip: "127.0.0.1", agent: "test" })}`;
  const firstCookie = sessionFor(first);
  const secondCookie = sessionFor(second);
  const post = (data, extra = {}) => fetch(url, {
    method: "POST",
    headers: { "x-vitrade": "1", cookie: firstCookie, "content-type": "application/json", ...extra },
    body: JSON.stringify(data),
  });
  try {
    assert.equal((await fetch(url)).status, 401);
    const initial = await (await fetch(url, { headers: { cookie: firstCookie } })).json();
    assert.deepEqual([initial.enabled, initial.equity, initial.budget, initial.leverage], [false, 10_000, 500, 5]);
    assert.equal((await post({ enabled: true }, { origin: "https://example.test" })).status, 403);
    assert.equal((await post({ enabled: "true" })).status, 400);
    const enabled = await post({ enabled: true, direction: "SHORT", regime: "quiet" });
    assert.equal(enabled.status, 200);
    assert.equal((await enabled.json()).enabled, true);
    const other = await (await fetch(url, { headers: { cookie: secondCookie } })).json();
    assert.equal(other.enabled, false);
    assert.deepEqual(readAccount(db, regular.id), original);
    assert.equal((await (await post({ enabled: false })).json()).enabled, false);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    db.close();
  }
});
