import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_CONFIG, gridPrice } from "../../server/engine/engine.js";
import { applyDumpReboundPreset } from "./dump-rebound-preset.js";

let server;
let Fork, Bots, BotForm;
const fork = { enabled: true, rapidPct: "20", windowSeconds: 60, totalPct: "50", stepPct: null, leverage: null, lossPct: "1", capMode: "multiple", capMultiple: "2", capAmount: "1000", extraLossPct: "3", maxMinutes: 30 };
const config = { name: "Основной шорт", mode: "manual", symbol: "BTCUSDT", direction: "SHORT", budget: "2000", leverage: 2, steps: 5, spacingPct: "10", tpPct: "2", slPct: "20", feeRate: "0.001", slippageRate: "0.001", marginAuto: false, marginCap: "100", stages: {}, exclusions: [], fork };
const parent = { id: "short", config, enabled: true, currentCycleId: "short-cycle" };
const child = { id: "long", config: { ...config, name: "Связанный лонг", direction: "LONG" }, forkParentId: "short", enabled: false, currentCycleId: null };
const state = { defaults: config, limits: { leverage: [1, 10], steps: [1, 20] } };
const account = { id: "account", name: "Paper", equity: "10000", bots: [parent], positions: [], cycles: [], forks: [] };
const render = (Component, props) => renderToStaticMarkup(createElement(Component, props));

before(async () => {
  server = await createServer({ configFile: fileURLToPath(new URL("../vite.config.js", import.meta.url)), server: { middlewareMode: true }, optimizeDeps: { noDiscovery: true, include: [] }, appType: "custom", logLevel: "error" });
  Fork = (await server.ssrLoadModule("/src/pages/Fork.jsx")).default;
  Bots = (await server.ssrLoadModule("/src/pages/Bots.jsx")).default;
  BotForm = (await server.ssrLoadModule("/src/pages/BotForm.jsx")).default;
});
after(async () => { await server?.close(); });

test("fork settings remain available without a position and do not invent a forecast", () => {
  const html = render(Fork, { account, state });
  assert.match(html, /У бота нет открытого шорта/);
  assert.match(html, /Сохранить настройки/);
  assert.match(html, /Наследовать шаг сетки шорта/);
  assert.match(html, /Наследовать плечо шорта/);
  assert.doesNotMatch(html, /Общий итог: счёт \+ кошелёк/);
});

test("an empty account links to bot creation", () => {
  const html = render(Fork, { account: { ...account, bots: [] }, state });
  assert.match(html, /Создайте основного бота/);
  assert.match(html, /href="#\/new"/);
});

test("an active pair with unavailable prices shows unknown result and close-both action", () => {
  const pair = { id: "pair", parentBotId: "short", childBotId: "long", symbol: "BTCUSDT", status: "OPEN", openedAt: Date.now(), targetPrice: "55000", targetNet: "-20", net: null, executable: false };
  const html = render(Fork, { account: { ...account, bots: [parent, child], forks: [pair] }, state });
  assert.match(html, /Закрыть обе позиции/);
  assert.match(html, /Нет свежей исполнимой котировки/);
  assert.match(html, /<strong class="flat">—<\/strong>/);
  assert.doesNotMatch(html, /option value="long"/);
});

test("closed child cannot be started, edited or deleted from Bots", () => {
  const html = render(Bots, { account: { ...account, bots: [child] } });
  assert.match(html, /История вилки/);
  assert.doesNotMatch(html, /Запустить|Настроить|Удалить/);
});

test("direct child edit route shows pair link without editing controls", () => {
  const html = render(BotForm, { account: { ...account, bots: [parent, child] }, state, botId: "long" });
  assert.match(html, /нельзя редактировать или запускать отдельно/);
  assert.match(html, /href="#\/fork\/short"/);
  assert.doesNotMatch(html, /<form/);
});

test("bot editor shows the saved price spacing separately from budget shares and previews engine levels", () => {
  const rebound = applyDumpReboundPreset(DEFAULT_CONFIG, Object.keys(DEFAULT_CONFIG.stages));
  const saved = { ...rebound, spacingPct: "3.25" };
  const html = render(BotForm, { account: { ...account, bots: [{ ...parent, config: saved }] }, state, botId: parent.id });
  assert.match(html, /<label>Шаг цены сетки, %<input[^>]*value="3\.25"/);
  assert.match(html, /<label>Первый вход, % бюджета сетки<input[^>]*value="12\.5"/);
  assert.equal(gridPrice({ direction: "SHORT", anchor: "100", config: saved }, 7).toString(), "122.75");
  assert.match(html, /<td>8<\/td><td class="num">\+22,75%<\/td>/);
});

test("bot editor keeps the number and size of steps for a saved equal-split grid", () => {
  const html = render(BotForm, { account, state, botId: parent.id });
  assert.match(html, /Всего шагов сетки/);
  assert.doesNotMatch(html, /Первый вход, % бюджета сетки/);
  assert.match(html, /<td>5<\/td><td class="num">\+40(?:,0+)?%<\/td>/);
  assert.doesNotMatch(html, /<td>6<\/td>/);
  assert.match(html, /400,00/);
});

test("both members of a closing pair show no independent bot controls", () => {
  const pair = { id: "pair", parentBotId: "short", childBotId: "long", status: "CLOSING" };
  const html = render(Bots, { account: { ...account, bots: [parent, child], forks: [pair] } });
  assert.equal((html.match(/Пара закрывается/g) || []).length, 2);
  assert.doesNotMatch(html, /Запустить|Настроить|Пауза докупок|Довести и стоп/);
});
