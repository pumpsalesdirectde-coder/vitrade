# DUMP SHORT Rebound Protection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a separate DUMP SHORT preset that takes +2.5% net profit and performs one restart-safe 50% recovery exit after a four-fill loss threshold.

**Architecture:** Extend the existing strategy/config vocabulary with `DUMP_REBOUND`, keep the protection disabled for legacy configurations, persist arm/completion metadata on each cycle, and reuse the engine's existing `reduce` path for the protective fill. Integrate a pure preset helper into the current bot form and map its partial fill reason in the existing history UI.

**Tech Stack:** Node.js 24, built-in `node:test`, Decimal.js, React 19, Vite 7, JSON account state in SQLite, GitHub-to-Render deployment.

**Spec:** `docs/superpowers/specs/2026-11-26-dump-short-rebound-design.md`

## Global Constraints

- Preserve the existing DUMP_ACCEL preset and all existing bots/open positions.
- Missing new fields must normalize to protection disabled; no database migration.
- Do not start bots or trading cycles during local or Render verification.
- Never copy `.env`, SQLite files, snapshots, or user data to GitHub/Render.
- Do not modify `VIMTrade-2026-11-17.zip`.

## Review Focus

- A recovery quote with no executable bid/ask must not mark the exit complete; a later executable quote must retry once.
- A full stop or take-profit condition on the same tick must close 100% before recovery protection can act.
- A loss below -$75 before four executed fills must not arm the protection.
- JSON serialize/deserialize between arming and recovery must preserve exactly-once behavior.
- The original DUMP_ACCEL preset must retain its hourly stop, blacklist, and single strategy label.

---

### Task 1: Preset and strategy vocabulary

**Files:**
- Create: `web/src/dump-rebound-preset.js`
- Create: `web/src/dump-rebound-preset.test.js`
- Modify: `server/engine/signals.js`
- Modify: `server/engine/engine.js`
- Modify: `web/src/format.js`
- Test: `server/engine/engine.test.js`

**Interfaces:**
- Produces: `applyDumpReboundPreset(config, strategyKeys, name?) -> config`
- Produces: strategy key `DUMP_REBOUND`, mapped from market stage `DUMP`
- Produces: config fields `recoveryExitOn`, `recoveryArmStep`, `recoveryArmNet`, `recoveryTargetNet`, `recoveryExitPct`

- [ ] **Step 1: Write failing preset and strategy-selection tests**

Assert the helper sets the approved grid/risk/cost values, selects only `DUMP_REBOUND`, disables the fork, and an auto bot records `stage === "DUMP_REBOUND"` on a DUMP signal while the old DUMP_ACCEL test remains unchanged.

- [ ] **Step 2: Run the focused tests and confirm they fail**

Run: `node --test web/src/dump-rebound-preset.test.js server/engine/engine.test.js`
Expected: FAIL because the helper/key does not exist.

- [ ] **Step 3: Implement the pure preset and strategy/config registration**

Add the exact approved values, append `DUMP_REBOUND` to shared stage maps/order, map DUMP picks deterministically, default and validate recovery fields, and force `recoveryExitOn` when the new strategy is selected.

- [ ] **Step 4: Run the focused tests**

Expected: PASS for preset selection, new DUMP mapping, and old DUMP_ACCEL behavior.

### Task 2: Stateful protective partial exit

**Files:**
- Modify: `server/engine/engine.js`
- Modify: `server/engine/engine.test.js`

**Interfaces:**
- Consumes: validated recovery config from Task 1
- Produces: cycle fields `recoveryExitArmedAt`, `recoveryExitArmedNet`, `recoveryExitDoneAt`, `recoveryExitFillId`; fill reason `RECOVERY_PARTIAL`

- [ ] **Step 1: Write failing threshold, restart, retry, priority, and no-repeat tests**

Cover no arming before four fills; arming at expected net <= -75; JSON round-trip; failed execution without bid/ask; successful later 50% reduction at expected net >= -10; DCA lock; no blacklist; no second partial fill; and full stop/take priority.

- [ ] **Step 2: Run focused engine tests and confirm the new cases fail**

Run: `node --test server/engine/engine.test.js`
Expected: FAIL on missing cycle state/protective fill.

- [ ] **Step 3: Implement `manageRecoveryExit(a, b, c, q, now)` around the existing `reduce` path**

Run it only while the cycle remains open, arm after DCA fills as well as before further DCA, set completion only after `reduce` returns true, and set `dcaLocked` only on success. Preserve normal stop/take checks before this helper.

- [ ] **Step 4: Carry recovery fields through live-cycle config updates**

Add the five config keys to `updateOpenCycle`; do not synthesize active state for old cycles.

- [ ] **Step 5: Run focused engine tests**

Expected: PASS, including original DUMP_ACCEL and ordinary partial-close regressions.

### Task 3: Bot form, reopen behavior, and history labeling

**Files:**
- Modify: `web/src/pages/BotForm.jsx`
- Modify: `web/src/format.js`
- Test: `web/src/dump-rebound-preset.test.js`

**Interfaces:**
- Consumes: `applyDumpReboundPreset` and recovery config fields
- Produces: selectable preset, reopened saved values, explanatory protection block, localized `RECOVERY_PARTIAL` fill label

- [ ] **Step 1: Extend the pure preset test with reopen-safe field assertions**

Assert all recovery settings use the expected boolean/number/string shapes and remain isolated from DUMP_ACCEL.

- [ ] **Step 2: Integrate the third special preset in `BotForm`**

Import the helper, preserve/restore the pre-preset snapshot, include the new key in manual-mode reset and direction preview, render the approved strategy description and all protection thresholds, and keep create-without-start available.

- [ ] **Step 3: Add the localized fill reason**

Map `RECOVERY_PARTIAL` to a clear 50% recovery-exit label so TradeChart markers and fill rows identify it.

- [ ] **Step 4: Run frontend unit tests and production build**

Run: `node --test web/src/*.test.js`
Run: `node node_modules/vite/bin/vite.js build --config web/vite.config.js`
Expected: all tests PASS and Vite build completes.

### Task 4: Normal create flow and persistence integration

**Files:**
- Create: `server/dump-rebound-api.test.js`
- Modify: none unless the test exposes an API compatibility issue

**Interfaces:**
- Consumes: existing `POST /api/accounts/:id/bots` and account storage
- Produces: evidence that a normal stopped bot can be created, stored, and reopened with the preset unchanged

- [ ] **Step 1: Write the authenticated API integration test**

Create an in-memory user/account, POST the preset with `start:false`, assert the returned bot is disabled, reload it from SQLite, and assert strategy plus all preset/recovery values. Confirm no cycle/fill is created.

- [ ] **Step 2: Run the API test and full suite**

Run: `node --test server/dump-rebound-api.test.js`
Run: `node --test "server/**/*.test.js" "web/src/*.test.js"`
Expected: all tests PASS and no bot is started.

### Task 5: Release and Render verification

**Files:**
- Modify: generated `web/dist/**` only through the normal build if the repository tracks it
- Do not add: databases, `.env`, logs, research output, or `node_modules`

**Interfaces:**
- Produces: one feature commit on a branch based on current `origin/master`, then deployment through the existing GitHub/Render flow

- [ ] **Step 1: Review the exact diff and tracked files**

Run: `git status --short`, `git diff --check`, `git diff --stat`, and inspect the full diff.

- [ ] **Step 2: Run full tests and production build from a clean feature tree**

Expected: zero test failures and successful Vite build.

- [ ] **Step 3: Commit and publish only feature files**

Commit message: `Add DUMP rebound partial-exit preset`. Push the feature onto current cloud history using the repository's normal deployment branch/PR path; never overwrite remote history.

- [ ] **Step 4: Verify Render without starting trading**

Confirm `https://vitrade.onrender.com/api/health` is healthy and the deployed bundle contains `DUMP_REBOUND` plus the Russian preset label. Use the ordinary UI create flow to create only a stopped bot if a dedicated safe account is available; otherwise rely on the authenticated integration test and do not mutate production user data.
