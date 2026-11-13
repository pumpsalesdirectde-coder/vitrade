import { test } from "node:test";
import assert from "node:assert/strict";
import { advance, command, createBot, newAccount, summarize, DEFAULT_CONFIG } from "./engine.js";
import { classifyStage } from "./signals.js";

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
  const b = createBot(a, { ...DEFAULT_CONFIG, slippageRate: "0" }, 0);
  command(a, b.id, "start", {}, 0);
  const now = 36e5 * 10;
  advance(a, quote("PUMPUSDT", 1, now, { stage: "FLIP", stageAt: now - 1000 }), now);
  assert.equal(a.cycles[0].direction, "SHORT");
  assert.equal(a.cycles[0].stage, "FLIP");
  const s = summarize(a, quote("PUMPUSDT", 1, now));
  assert.equal(s.positions[0].grid.length, 8);
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
