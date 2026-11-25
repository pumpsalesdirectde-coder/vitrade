export const DUMP_REBOUND_NAME = "DUMP SHORT — тейк 2,5% и выход 50% при восстановлении";

export const recoveryExitFormConfig = (config) => ({
  recoveryExitOn: config.recoveryExitOn === true,
  recoveryArmStep: Number(config.recoveryArmStep ?? 4),
  recoveryArmNet: String(config.recoveryArmNet ?? "-75"),
  recoveryTargetNet: String(config.recoveryTargetNet ?? "-10"),
  recoveryExitPct: String(config.recoveryExitPct ?? "50"),
});

export function applyDumpReboundPreset(config, strategyKeys, name = DUMP_REBOUND_NAME) {
  return {
    ...config, name, mode: "auto", direction: "SHORT",
    budget: "500", leverage: 5, steps: 7, spacingPct: "4.5", entryPct: "12.5",
    orderPcts: Array(8).fill("12.5"), tpPct: "2.5", slPct: "200",
    feeRate: "0.0005", slippageRate: "0.0002",
    marginAuto: true, marginCap: "1000",
    guardOn: true, guardStep: 3, guardPct: "20", guardMinutes: 60,
    accelerationStopOn: true, accelerationStopPct: "10",
    recoveryExitOn: true, recoveryArmStep: 4, recoveryArmNet: "-75",
    recoveryTargetNet: "-10", recoveryExitPct: "50",
    fork: { ...config.fork, enabled: false },
    stages: Object.fromEntries(strategyKeys.map((key) => [key, key === "DUMP_REBOUND"])),
  };
}
