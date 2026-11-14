import test from "node:test";
import assert from "node:assert/strict";
import { createForkDraft, forkDraftReducer, forkDraftDirty, activeFork } from "./fork-state.js";

const settings = { enabled: true, rapidPct: "20", stepPct: null, leverage: null };

test("market polling preserves unsaved fork settings including inherit choices", () => {
  let draft = createForkDraft(settings);
  draft = forkDraftReducer(draft, { type: "edit", key: "stepPct", value: "7.5" });
  draft = forkDraftReducer(draft, { type: "sync", settings: { ...settings, rapidPct: "25" } });
  assert.equal(draft.settings.stepPct, "7.5");
  assert.equal(draft.settings.rapidPct, "20");
  assert.equal(draft.settings.leverage, null);
  assert.equal(forkDraftDirty(draft), true);
});

test("pristine fork form accepts changed saved settings from another session", () => {
  const changed = { ...settings, enabled: false };
  const draft = forkDraftReducer(createForkDraft(settings), { type: "sync", settings: changed });
  assert.deepEqual(draft.settings, changed);
  assert.equal(forkDraftDirty(draft), false);
});

test("save response does not discard a newer edit made while saving", () => {
  let draft = forkDraftReducer(createForkDraft(settings), { type: "edit", key: "rapidPct", value: "30" });
  const submitted = draft.settings;
  draft = forkDraftReducer(draft, { type: "edit", key: "rapidPct", value: "35" });
  draft = forkDraftReducer(draft, { type: "saved", settings: submitted });
  assert.equal(draft.settings.rapidPct, "35");
  assert.equal(forkDraftDirty(draft), true);
  draft = forkDraftReducer(draft, { type: "saved", settings: draft.settings });
  assert.equal(forkDraftDirty(draft), false);
});

test("both pair members stay linked while closing and closed history never locks a new cycle", () => {
  const pair = { parentBotId: "short", childBotId: "long", status: "CLOSING" };
  assert.equal(activeFork([pair], "short"), pair);
  assert.equal(activeFork([pair], "long"), pair);
  assert.equal(activeFork([{ ...pair, status: "CLOSED" }], "short"), undefined);
});
