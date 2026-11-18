import { test } from "node:test";
import assert from "node:assert/strict";
import { applyFlipRiskPreset, flipRiskSizing } from "./flip-risk-preset.js";

test("risk sizing respects the per-bot and simultaneous exposure limits", () => {
  assert.deepEqual(flipRiskSizing(10000), { budget: "200.00", bots: 6, stop: 30, entry: 150, addition: 50 });
  assert.equal(flipRiskSizing(15000).budget, "300.00");
  assert.equal(flipRiskSizing(15000).bots, 6);
});

test("FLIP risk preset selects only its own strategy and fills one addition", () => {
  const config = applyFlipRiskPreset({ name: "Bot", stages: { DUMP: true }, fork: { enabled: true } }, 10000,
    ["FLIP", "FLIP_RISK", "DUMP"]);
  assert.deepEqual(config.stages, { FLIP: false, FLIP_RISK: true, DUMP: false });
  assert.equal(config.budget, "200.00");
  assert.equal(config.entryPct, "75");
  assert.equal(config.orderPcts[0], "25");
  assert.equal(config.steps, 1);
  assert.equal(config.leverage, 2);
  assert.equal(config.fork.enabled, false);
  assert.equal(config.marginAuto, false);
});
