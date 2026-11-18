// Financial preset for the existing FLIP signal. Amounts are fixed when the bot is created.
export function flipRiskSizing(equity) {
  const capital = Number(equity);
  if (!Number.isFinite(capital) || capital <= 0) throw new RangeError("Счёт должен быть положительным");
  const budget = Math.floor(capital * 0.02 * 100) / 100;
  if (budget < 1) throw new RangeError("Недостаточно средств для минимального бюджета бота");
  const stop = budget * 0.15;
  const bots = Math.max(0, Math.min(
    Math.floor(capital * 0.02 / stop),
    Math.floor(capital * 0.20 / budget),
    Math.floor(capital * 0.30 / (budget * 2)),
  ));
  return { budget: budget.toFixed(2), bots, stop, entry: budget * 0.75, addition: budget * 0.25 };
}

export function applyFlipRiskPreset(config, equity, strategyKeys, name = config.name) {
  const { budget } = flipRiskSizing(equity);
  return {
    ...config, name, mode: "auto", direction: "SHORT", budget, leverage: 2,
    steps: 1, spacingPct: "4.5", entryPct: "75",
    orderPcts: ["25", ...Array(7).fill("4.5")], tpPct: "10", slPct: "15",
    feeRate: "0.00055", slippageRate: "0.0002",
    marginAuto: false, marginCap: "0", guardOn: false, accelerationStopOn: false,
    fork: { ...config.fork, enabled: false },
    stages: Object.fromEntries(strategyKeys.map((key) => [key, key === "FLIP_RISK"])),
  };
}
