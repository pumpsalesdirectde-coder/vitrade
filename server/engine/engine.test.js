import { test } from "node:test";
import assert from "node:assert/strict";
import { advance, command, createBot, newAccount, summarize, validateConfig, DEFAULT_CONFIG } from "./engine.js";
import { classifyStage } from "./signals.js";
import { collectAcceleration } from "../market/bybit.js";

const quote = (symbol, mark, now, extra = {}) => ({
  [symbol]: { symbol, mark: String(mark), bid: String(mark), ask: String(mark), at: now, source: "market", turnover: "1000000", ...extra },
});

function manualAccount(direction = "SHORT") {
  const a = newAccount("a1", "local", "Тест", "market", 0);
  const cfg = { ...DEFAULT_CONFIG, mode: "manual", symbol: "XUSDT", direction, budget: "800", steps: 8, spacingPct: "5", tpPct: "2", slippageRate: "0" };
  const b = createBot(a, cfg, 0);
  command(a, b.id, "start", {}, 0);
  return { a, b };
}

test("hourly 10% exit blacklists the coin and keeps the bot active", () => {
  const a = newAccount("accel", "local", "Acceleration", "market", 0);
  const cfg = { ...DEFAULT_CONFIG, mode: "manual", symbol: "XUSDT", budget: "500",
    tpPct: "1.5", slPct: "200", marginCap: "1000", feeRate: "0.0005",
    accelerationStopOn: true, accelerationStopPct: "10" };
  const b = createBot(a, cfg, 0);
  command(a, b.id, "start", {}, 0);
  advance(a, quote("XUSDT", 100, 600000), 600000);
  advance(a, quote("XUSDT", 104.5, 600001), 600001);
  advance(a, quote("XUSDT", 109, 600002), 600002);
  assert.equal(a.cycles[0].usedSteps, 3);
  advance(a, quote("XUSDT", 115, 930000, { accelerationAt: 900000, accelerationGainPct: 10.1 }), 930000);
  assert.equal(a.cycles[0].closeReason, "STOP_LOSS");
  assert.equal(a.cycles[0].protectionTrigger, "ACCEL_1H_10PCT");
  assert.deepEqual(a.stopBlacklist, ["XUSDT"]);
  assert.equal(b.enabled, true);
  advance(a, quote("XUSDT", 100, 900001), 900001);
  assert.equal(a.cycles.length, 1);
});

test("hourly gain uses thirteen contiguous completed five-minute closes", async () => {
  const at = 20 * 300000;
  const rows = Array.from({ length: 14 }, (_, i) => [String((at / 300000 - 13 + i) * 300000), "0", "0", "0", String(i === 12 ? 110 : 100)]);
  const fetcher = async () => ({ ok: true, json: async () => ({ retCode: 0, result: { list: rows } }) });
  assert.equal((await collectAcceleration(fetcher, "XUSDT", at)).accelerationGainPct, 10.000000000000009);
  rows.splice(5, 1);
  assert.equal((await collectAcceleration(fetcher, "XUSDT", at)).accelerationGainPct, null);
});

test("ручной шорт: вход, докупка по сетке, тейк-профит", () => {
  const { a, b } = manualAccount("SHORT");
  advance(a, quote("XUSDT", 100, 1000), 1000);
  const c = a.cycles[0];
  assert.equal(c.usedSteps, 1);
  assert.equal(c.anchor, "100");
  advance(a, quote("XUSDT", 105, 2000), 2000); // +5% против шорта — второй шаг
  assert.equal(c.usedSteps, 2);
  advance(a, quote("XUSDT", 95, 3000), 3000); // падение — прибыль выше 2% бюджета
  assert.equal(c.status, "CLOSED");
  assert.equal(c.closeReason, "TAKE_PROFIT");
  assert.equal(b.currentCycleId, null);
  assert.ok(Number(a.cash) > 10000);
});

test('настройки открытой сделки обновляют будущие шаги и защиту без изменения исполненного входа', () => {
  const { a, b } = manualAccount('SHORT');
  advance(a, quote('XUSDT', 100, 1000), 1000);
  const c = a.cycles[0];
  const first = a.fills[0];
  const spent = Number(c.config.budget) - Number(c.remainingBudget);
  const next = { ...b.config, budget: '1000', leverage: 3, tpPct: '3', slPct: '50',
    steps: 7, spacingPct: '4.5', marginAuto: false, orderPcts: b.config.orderPcts.map((pct, i) => i === 0 ? '6' : pct) };
  command(a, b.id, 'update', next, 1500);
  assert.equal(c.config.budget, '1000');
  assert.equal(c.config.tpPct, '3');
  assert.equal(c.config.slPct, '50');
  assert.equal(c.config.marginAuto, false);
  assert.equal(c.config.leverage, 5);
  assert.equal(b.config.leverage, 3);
  assert.equal(c.config.entryPct, '4.5');
  assert.equal(Number(c.remainingBudget), 1000 - spent);
  advance(a, quote('XUSDT', 104.5, 2000), 2000);
  assert.equal(c.usedSteps, 2);
  assert.ok(Math.abs(Number(a.fills[1].quantity) * Number(a.fills[1].price) - 300) < 1e-8);
  assert.equal(a.fills[0].id, first.id);
  assert.equal(a.fills[0].quantity, first.quantity);
});

test('нельзя сократить живую сетку ниже выполненного или уменьшить бюджет ниже потраченного', () => {
  const { a, b } = manualAccount('SHORT');
  advance(a, quote('XUSDT', 100, 1000), 1000);
  advance(a, quote('XUSDT', 105, 2000), 2000);
  advance(a, quote('XUSDT', 110, 3000), 3000);
  const c = a.cycles[0], original = structuredClone(c);
  assert.throws(() => command(a, b.id, 'update', { ...b.config, steps: 1 }, 2500), /исполненных шагов/);
  assert.throws(() => command(a, b.id, 'update', { ...b.config, budget: '10' }, 2500), /бюджет меньше/);
  assert.throws(() => command(a, b.id, 'update', { ...b.config, orderPcts: ['0.01', '0.01', ...Array(6).fill('15.8')] }, 2500), /будущие докупки превышают/);
  assert.throws(() => command(a, b.id, 'update', { ...b.config, budget: '100000' }, 2500), /свободных средств/);
  assert.deepEqual(c, original);
  assert.equal(b.config.steps, 8);
});

test("пауза останавливает докупки, закрытие по рынку закрывает позицию", () => {
  const { a, b } = manualAccount("LONG");
  advance(a, quote("XUSDT", 100, 1000), 1000);
  command(a, b.id, "pause", {}, 1500);
  advance(a, quote("XUSDT", 94, 2000), 2000); // −6% — шаг сетки был бы, но пауза
  assert.equal(a.cycles[0].usedSteps, 1);
  command(a, b.id, "close", {}, 2500);
  advance(a, quote("XUSDT", 94, 3000), 3000);
  assert.equal(a.cycles[0].status, "CLOSED");
  assert.equal(a.cycles[0].closeReason, "MANUAL");
  assert.equal(b.enabled, false);
});

test("авто-бот входит по стадии FLIP в шорт", () => {
  const a = newAccount("a2", "local", "Тест", "market", 0);
  const b = createBot(a, { ...DEFAULT_CONFIG, stages: { ...DEFAULT_CONFIG.stages, FLIP: true }, slippageRate: "0" }, 0);
  command(a, b.id, "start", {}, 0);
  const now = 36e5 * 10;
  advance(a, quote("PUMPUSDT", 1, now, { stage: "FLIP", stageAt: now - 1000 }), now);
  assert.equal(a.cycles[0].direction, "SHORT");
  assert.equal(a.cycles[0].stage, "FLIP");
  const s = summarize(a, quote("PUMPUSDT", 1, now));
  assert.equal(s.positions[0].grid.length, 9);
});

test("классификатор стадий: памп +30% и откат 8% — FLIP", () => {
  const h = [], l = [], c = [];
  for (let i = 0; i < 60; i++) {
    const p = i < 40 ? 1 : i < 50 ? 1 + (i - 39) * 0.03 : 1.3 - (i - 49) * 0.01;
    h.push(p * 1.001); l.push(p * 0.999); c.push(p);
  }
  c[59] = 1.3 * 0.92;
  assert.equal(classifyStage(h, l, c).stage, "FLIP");
});

test("подстраховка: рост на 20%+ за час после 3-го шага останавливает докупки", () => {
  const { a, b } = manualAccount("SHORT");
  const min = 6e4;
  advance(a, quote("XUSDT", 100, min), min); // шаг 1
  advance(a, quote("XUSDT", 105, 10 * min), 10 * min); // шаг 2
  advance(a, quote("XUSDT", 110, 20 * min), 20 * min); // шаг 3
  const c = a.cycles[0];
  assert.equal(c.usedSteps, 3);
  advance(a, quote("XUSDT", 121, 30 * min), 30 * min); // +21% от минимума часа — шаги 4 и 5 не исполняются
  assert.equal(c.dcaLocked, true);
  assert.equal(c.usedSteps, 3);
  assert.ok(a.events.some((e) => e.type === "GUARD"));
  assert.equal(c.status, "OPEN");
  assert.equal(b.currentCycleId, c.id);
});

test("подстраховка выключена — сетка докупает как обычно", () => {
  const a = newAccount("a3", "local", "Тест", "market", 0);
  const b = createBot(a, { ...DEFAULT_CONFIG, mode: "manual", symbol: "XUSDT", budget: "800", spacingPct: "5", slippageRate: "0", guardOn: false }, 0);
  command(a, b.id, "start", {}, 0);
  const min = 6e4;
  for (const [t, p] of [[1, 100], [10, 105], [20, 110], [30, 121]]) advance(a, quote("XUSDT", p, t * min), t * min);
  assert.equal(a.cycles[0].usedSteps, 5);
  assert.notEqual(a.cycles[0].dcaLocked, true);
});

test("custom order percentages spend the configured share of grid budget", () => {
  const a = newAccount("custom", "local", "Test", "market", 0);
  const b = createBot(a, { ...DEFAULT_CONFIG, mode: "manual", symbol: "XUSDT", budget: "1000", leverage: 1,
    spacingPct: "2", entryPct: "5", orderPcts: ["6", "7", "8", "9", "10", "11", "12", "13"],
    slPct: "1000", tpPct: "1000", guardOn: false, marginAuto: false, slippageRate: "0", feeRate: "0" }, 0);
  command(a, b.id, "start", {}, 0);
  advance(a, quote("XUSDT", 100, 1000), 1000);
  assert.equal(a.cycles[0].usedSteps, 1);
  assert.equal(a.fills[0].quantity, "0.5");
  for (let i = 1; i <= 8; i++) advance(a, quote("XUSDT", 100 + i * 2, 1000 + i * 1000), 1000 + i * 1000);
  assert.equal(a.cycles[0].usedSteps, 9);
  assert.equal(a.fills.length, 9);
  assert.equal(a.cycles[0].remainingBudget, "190");
  assert.equal(summarize(a, quote("XUSDT", 116, 9000)).positions[0].grid.length, 9);
  assert.throws(() => validateConfig({ ...b.config, entryPct: "95" }), /100%/);
});

test("new bot strategies start unchecked", () => {
  assert.ok(Object.values(DEFAULT_CONFIG.stages).every((value) => value === false));
});

test("researched eight-order grid uses the full budget at 12.5 percent per order", () => {
  const a = newAccount("eight", "local", "Eight orders", "market", 0);
  const b = createBot(a, { ...DEFAULT_CONFIG, mode: "manual", symbol: "XUSDT", budget: "500", leverage: 5,
    steps: 7, entryPct: "12.5", orderPcts: Array(8).fill("12.5"), spacingPct: "4.5",
    tpPct: "1.5", slPct: "200", marginAuto: true, marginCap: "1000", guardOn: false,
    feeRate: "0.0005", slippageRate: "0", accelerationStopOn: true }, 0);
  command(a, b.id, "start", {}, 0);
  advance(a, quote("XUSDT", 100, 1000), 1000);
  for (let i = 1; i <= 7; i++) advance(a, quote("XUSDT", 100 + 4.5 * i, 1000 + i * 1000), 1000 + i * 1000);
  assert.equal(a.cycles[0].usedSteps, 8);
  assert.equal(a.cycles[0].remainingBudget, "0");
  assert.equal(a.fills.filter((f) => f.action === "increase").length, 8);
});

test("acceleration strategy is a separate DUMP selection and enables its protection", () => {
  const a = newAccount("dump-accel", "local", "DUMP acceleration", "market", 0);
  const b = createBot(a, { ...DEFAULT_CONFIG, mode: "auto", direction: "SHORT",
    stages: { ...DEFAULT_CONFIG.stages, DUMP_ACCEL: true }, accelerationStopOn: false,
    steps: 7, entryPct: "12.5", orderPcts: Array(8).fill("12.5") }, 0);
  assert.equal(b.config.accelerationStopOn, true);
  command(a, b.id, "start", {}, 0);
  advance(a, quote("XUSDT", 100, 3600000, { stage: "PUMP", stageAt: 3600000 }), 3600000);
  assert.equal(a.cycles.length, 0);
  advance(a, quote("XUSDT", 100, 3600001, { stage: "DUMP", stageAt: 3600000 }), 3600001);
  assert.equal(a.cycles.length, 1);
  assert.equal(a.cycles[0].stage, "DUMP_ACCEL");
  assert.equal(a.cycles[0].direction, "SHORT");
});
