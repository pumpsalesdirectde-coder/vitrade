import { test } from "node:test";
import assert from "node:assert/strict";
import * as dumpPreset from "./dump-rebound-preset.js";

test("DUMP rebound preset applies the approved isolated eight-order strategy", () => {
  const config = dumpPreset.applyDumpReboundPreset({
    name: "Bot",
    stages: { DUMP: true, DUMP_ACCEL: false, DUMP_REBOUND: false, FLIP: true },
    fork: { enabled: true },
  }, ["DUMP", "DUMP_ACCEL", "DUMP_REBOUND", "FLIP"]);

  assert.deepEqual(config.stages, { DUMP: false, DUMP_ACCEL: false, DUMP_REBOUND: true, FLIP: false });
  assert.equal(config.name, "DUMP SHORT — тейк 2,5% и выход 50% при восстановлении");
  assert.equal(config.mode, "auto");
  assert.equal(config.direction, "SHORT");
  assert.equal(config.budget, "500");
  assert.equal(config.leverage, 5);
  assert.equal(config.steps, 7);
  assert.equal(config.spacingPct, "4.5");
  assert.equal(config.entryPct, "12.5");
  assert.deepEqual(config.orderPcts, Array(8).fill("12.5"));
  assert.equal(config.tpPct, "2.5");
  assert.equal(config.slPct, "200");
  assert.equal(config.feeRate, "0.0005");
  assert.equal(config.slippageRate, "0.0002");
  assert.equal(config.marginAuto, true);
  assert.equal(config.marginCap, "1000");
  assert.equal(config.guardOn, true);
  assert.equal(config.guardStep, 3);
  assert.equal(config.guardPct, "20");
  assert.equal(config.guardMinutes, 60);
  assert.equal(config.accelerationStopOn, true);
  assert.equal(config.accelerationStopPct, "10");
  assert.equal(config.recoveryExitOn, true);
  assert.equal(config.recoveryArmStep, 4);
  assert.equal(config.recoveryArmNet, "-75");
  assert.equal(config.recoveryTargetNet, "-10");
  assert.equal(config.recoveryExitPct, "50");
  assert.equal(config.fork.enabled, false);
});

test("bot form normalization reopens recovery settings and keeps legacy bots disabled", () => {
  assert.equal(typeof dumpPreset.recoveryExitFormConfig, "function");
  assert.deepEqual(dumpPreset.recoveryExitFormConfig({
    recoveryExitOn: true,
    recoveryArmStep: 4,
    recoveryArmNet: "-75",
    recoveryTargetNet: "-10",
    recoveryExitPct: "50",
  }), {
    recoveryExitOn: true,
    recoveryArmStep: 4,
    recoveryArmNet: "-75",
    recoveryTargetNet: "-10",
    recoveryExitPct: "50",
  });
  assert.deepEqual(dumpPreset.recoveryExitFormConfig({}), {
    recoveryExitOn: false,
    recoveryArmStep: 4,
    recoveryArmNet: "-75",
    recoveryTargetNet: "-10",
    recoveryExitPct: "50",
  });
});
