# DUMP SHORT Rebound Protection Design

## Intent

Add a selectable preset named `DUMP SHORT — тейк 2,5% и выход 50% при восстановлении` without changing the existing `DUMP SHORT — выход 10% за час` preset. The new preset trades the same DUMP signal with the approved $500 / x5 / eight-order grid, keeps the normal monetary stop, hourly stop, guard, margin cushion, fees, slippage, and funding accounting, and adds one stateful protective partial exit.

## Goals

- Apply the exact approved preset values: $500 budget, x5 leverage, 12.5% entry plus seven 12.5% additions at 4.5% intervals, 2.5% budget take profit, 200% budget stop, hourly 10% stop after three fills, 20%/60-minute DCA guard from step three, automatic margin with a $1,000 cap, 0.05% fee, 0.02% slippage, funding included, and fork disabled.
- After four executed fills, arm once when expected net liquidation result is at most -$75. On a later recovery to at least -$10, close exactly 50% of current quantity once and lock further automatic DCA for that cycle.
- Persist armed/completed state in the account cycle JSON, retry if an executable bid/ask is unavailable, keep stop/take-profit priority, and never blacklist the coin for this partial exit.
- Keep the remaining cycle's take-profit target at +$12.50 total net result including realized partial result, all fees, and funding.
- Show the preset and protection settings in the bot form, preserve them when reopening, and identify the protective partial fill in history.
- Keep legacy bots and open cycles unchanged by default. Do not start or migrate any bot automatically.

## Non-goals and anti-goals

- Do not alter the existing DUMP_ACCEL preset or its trading behavior.
- Do not reinterpret historical research files as runtime conditions.
- Do not migrate existing bots, positions, databases, environment files, or user data.
- Do not enable a fork or launch a trading cycle during verification.

## Constraints

- Source baseline for historical comparison is `VIMTrade-2026-11-17`; deploy only the feature changes on top of current `origin/master` (`908649d` at planning time).
- The source ZIP remains untouched.
- Existing JSON documents must remain readable without a schema migration; missing protection fields normalize to disabled defaults.
- Render deployment must use the existing GitHub/Render flow and preserve the persistent database.

## Approaches

1. **Cycle-local state plus direct reuse of `reduce` (chosen).** Add configuration fields and `DUMP_REBOUND`, store arm/completion metadata on the open cycle, and call the existing partial-reduction path. This is restart-safe, naturally uses existing money/fill accounting, and needs no queue migration.
2. **Enqueue an ordinary `partial` command.** This reuses the command queue but risks duplicate queued commands across ticks/restarts and makes successful versus attempted execution harder to distinguish.
3. **Create a separate recovery order subsystem.** This is disproportionate to one deterministic partial exit and would duplicate accounting and persistence logic.

## Runtime flow

For every fresh quote, normal liquidation, monetary stop, hourly stop, and take profit run first. If the cycle remains open, protection records `armedAt` and the net value when `usedSteps >= 4` and expected net is `<= -75`. Once armed, a later expected net `>= -10` attempts `reduce(..., 50, "RECOVERY_PARTIAL")`. Only a successful reduction records completion and locks DCA. A failed reduction leaves the cycle armed for retry. A second successful protective reduction is impossible because completion is persisted.

## Compatibility

New configuration fields default to disabled values during validation. Existing cycles retain their copied configuration and acquire no active protection. The new strategy maps the existing DUMP market stage to a distinct entry label. Existing DUMP and DUMP_ACCEL selection and close behavior remain covered by regression tests.
