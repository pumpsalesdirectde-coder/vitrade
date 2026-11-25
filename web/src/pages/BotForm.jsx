import { useEffect, useMemo, useRef, useState } from "react";
import { get, post } from "../api.js";
import { STRATEGY, STRATEGY_ORDER, coin, money, pct, price } from "../format.js";
import { applyFlipRiskPreset, flipRiskSizing } from "../flip-risk-preset.js";
import { applyDumpReboundPreset, recoveryExitFormConfig } from "../dump-rebound-preset.js";
import Hint from "../ui/Hint.jsx";

const levelFormat = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 12, signDisplay: "exceptZero" });
const validSpacing = (value) => Number(value) >= 0.01 && Number(value) <= 10;

/** Расчёт сетки на условной цене входа 100 или текущей цене монеты. */
function ladder(cfg, entry) {
  const steps = Number(cfg.steps);
  const budget = Number(cfg.budget);
  const lev = Number(cfg.leverage);
  const spacing = Number(cfg.spacingPct);
  const fee = Number(cfg.feeRate);
  const dir = cfg.direction === "LONG" ? -1 : 1; // направление, куда идёт цена против позиции
  if (!(steps > 0 && budget > 0 && lev > 0 && validSpacing(spacing) && entry > 0)) return [];
  let qty = 0;
  let cost = 0;
  let margin = 0;
  const rows = [];
  for (let i = 0; i < steps + (cfg.orderPcts ? 1 : 0); i++) {
    const move = dir * spacing * i;
    const p = entry * (1 + move / 100);
    const amount = cfg.orderPcts ? budget * Number(i === 0 ? cfg.entryPct : cfg.orderPcts[i - 1]) / 100 : budget / steps;
    const q = (amount * lev) / p;
    qty += q;
    cost += q * p;
    margin += amount - q * p * fee;
    const liq = cfg.direction === "LONG" ? (cost - margin) / (qty * 0.995) : (cost + margin) / (qty * 1.005);
    rows.push({ i, p, move, amount, used: margin, volume: cost, liqMove: (liq / p - 1) * 100 });
  }
  return rows;
}

const pickConfig = (c) => ({
  name: c.name, mode: c.mode, symbol: c.symbol, direction: c.direction, budget: String(c.budget), leverage: Number(c.leverage),
  steps: Number(c.steps), spacingPct: String(c.spacingPct), entryPct: String(c.entryPct ?? "4.5"),
  orderPcts: c.orderPcts?.map(String), tpPct: String(c.tpPct), slPct: String(c.slPct),
  feeRate: String(c.feeRate), slippageRate: String(c.slippageRate), marginAuto: !!c.marginAuto, marginCap: String(c.marginCap),
  exclusions: c.exclusions || [], stages: { ...c.stages }, fork: c.fork,
  guardOn: c.guardOn === true, guardStep: Number(c.guardStep ?? 3), guardPct: String(c.guardPct ?? "20"), guardMinutes: Number(c.guardMinutes ?? 60),
  accelerationStopOn: c.stages?.DUMP_ACCEL === true || c.accelerationStopOn === true, accelerationStopPct: String(c.accelerationStopPct ?? "10"),
  ...recoveryExitFormConfig(c),
});

export default function BotForm({ account: a, state, botId, refresh }) {
  const editing = a.bots.find((b) => b.id === botId);
  const [cfg, setCfg] = useState(() => pickConfig(editing ? editing.config : { ...state.defaults, name: `Бот ${a.bots.length + 1}` }));
  const beforePreset = useRef(null);
  const [excl, setExcl] = useState((editing?.config.exclusions || state.defaults.exclusions).map(coin).join(", "));
  const [quotes, setQuotes] = useState([]);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const riskSizing = Number(a.equity) >= 50 ? flipRiskSizing(a.equity) : null;
  useEffect(() => {
    get("/api/market").then((m) => setQuotes(m.quotes)).catch(() => {});
  }, []);
  const restorePreviousConfig = (prev, snapshot) => {
    const original = snapshot ?? pickConfig({ ...state.defaults, name: prev.name });
    return { ...original, stages: { ...original.stages, DUMP_ACCEL: false, DUMP_REBOUND: false, FLIP_RISK: false } };
  };
  const set = (k) => (e) => {
    const value = e.target.type === "checkbox" ? e.target.checked : e.target.type === "number" ? Number(e.target.value) : e.target.value;
    const snapshot = beforePreset.current;
    if (k === "mode" && value === "manual" && (cfg.stages.DUMP_ACCEL || cfg.stages.DUMP_REBOUND || cfg.stages.FLIP_RISK)) beforePreset.current = null;
    setCfg((prev) => k === "mode" && value === "manual" && (prev.stages.DUMP_ACCEL || prev.stages.DUMP_REBOUND || prev.stages.FLIP_RISK)
      ? { ...restorePreviousConfig(prev, snapshot), mode: value }
      : { ...prev, [k]: value });
  };
  const setOrderPct = (index) => (e) => setCfg((prev) => ({ ...prev, orderPcts: prev.orderPcts.map((v, i) => i === index ? e.target.value : v) }));
  const applyDump10Preset = (prev) => ({
    ...prev, name: editing ? prev.name : "DUMP SHORT — выход 10% за час", mode: "auto", direction: "SHORT",
    budget: "500", leverage: 5, steps: 7, spacingPct: "4.5", entryPct: "12.5",
    orderPcts: Array(8).fill("12.5"), tpPct: "1.5", slPct: "200",
    feeRate: "0.0005", slippageRate: "0.0002", marginAuto: true, marginCap: "1000",
    guardOn: true, guardStep: 3, guardPct: "20", guardMinutes: 60,
    accelerationStopOn: true, accelerationStopPct: "10",
    recoveryExitOn: false,
    fork: { ...prev.fork, enabled: false },
    stages: Object.fromEntries(STRATEGY_ORDER.map((key) => [key, key === "DUMP_ACCEL"])),
  });
  const selectStrategy = (key, checked) => {
    if (key === "FLIP_RISK" && checked && !riskSizing) {
      setErr("Для этой стратегии капитал счёта должен быть не меньше $50.");
      return;
    }
    setErr("");
    const snapshot = beforePreset.current;
    const special = key === "DUMP_ACCEL" || key === "DUMP_REBOUND" || key === "FLIP_RISK";
    const wasPreset = cfg.stages.DUMP_ACCEL || cfg.stages.DUMP_REBOUND || cfg.stages.FLIP_RISK;
    if (special && checked && !wasPreset) beforePreset.current = structuredClone(cfg);
    else if (wasPreset && (!special || !checked)) beforePreset.current = null;
    setCfg((prev) => {
      if (key === "DUMP_ACCEL") return checked ? applyDump10Preset(prev) : restorePreviousConfig(prev, snapshot);
      if (key === "DUMP_REBOUND") return checked
        ? applyDumpReboundPreset(prev, STRATEGY_ORDER, editing ? prev.name : undefined)
        : restorePreviousConfig(prev, snapshot);
      if (key === "FLIP_RISK") return checked
        ? applyFlipRiskPreset(prev, a.equity, STRATEGY_ORDER, editing ? prev.name : "Подтверждённый разворот — расчётный риск")
        : restorePreviousConfig(prev, snapshot);
      const base = wasPreset ? restorePreviousConfig(prev, snapshot) : prev;
      return { ...base, stages: { ...base.stages, [key]: checked } };
    });
  };
  const manual = cfg.mode === "manual";
  const mark = Number(quotes.find((q) => q.symbol === cfg.symbol)?.mark || 0);
  const entry = manual && mark ? mark : 100;
  // У авто-бота сторону задаёт стратегия: лонг только у «Отскока» и RSI-лонга.
  const shortPicked = ["RSI_SHORT", "PUMP", "EARLY", "FLIP", "FLIP_RISK", "DUMP", "DUMP_ACCEL", "DUMP_REBOUND"].some((k) => cfg.stages[k]);
  const dirPrev = manual ? cfg.direction : shortPicked ? "SHORT" : "LONG";
  const rows = useMemo(() => ladder({ ...cfg, direction: dirPrev }, entry), [cfg, entry, dirPrev]);
  const last = rows.at(-1);
  // Каждый бот может занять бюджет сетки и, если включена подушка, ещё до marginCap на защиту от ликвидации.
  const others = a.bots.filter((b) => b.id !== editing?.id && b.enabled);
  const otherBudgets = others.reduce((s, b) => s + Number(b.config.budget), 0);
  const otherCushions = others.reduce((s, b) => s + (b.config.marginAuto ? Number(b.config.marginCap) || 0 : 0), 0);
  const thisCushion = cfg.marginAuto ? Number(cfg.marginCap) || 0 : 0;
  const capital = Number(a.equity);
  const parts = [
    ["Другие боты: бюджеты", otherBudgets, "seg-other"],
    ["Другие боты: подушка маржи", otherCushions, "seg-other-cushion"],
    ["Этот бот: бюджет", Number(cfg.budget) || 0, "seg-this"],
    ["Этот бот: подушка маржи", thisCushion, "seg-cushion"],
  ].filter(([, v], i) => v > 0 || i === 2);
  const restFree = capital - parts.reduce((s, [, v]) => s + v, 0);
  const liveCycle = editing && a.cycles.find((c) => c.id === editing.currentCycleId && c.status === "OPEN");
  const busyBot = editing && editing.currentCycleId;
  const fork = cfg.fork ?? state.defaults.fork;

  const submit = async (start) => {
    if (!validSpacing(cfg.spacingPct)) {
      setErr("Шаг цены сетки должен быть от 0,01 до 10%.");
      return;
    }
    setBusy(true);
    try {
      const config = { ...cfg, fork, exclusions: excl.split(/[\s,;]+/).filter(Boolean).map((s) => s.toUpperCase().replace(/USDT$/, "") + "USDT") };
      if (editing) await post(`/api/accounts/${a.id}/bots/${editing.id}/commands`, { action: "update", payload: config });
      else await post(`/api/accounts/${a.id}/bots`, { config, start });
      refresh();
      location.hash = "#/bots";
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (editing?.forkParentId) return <div className="empty-state"><h2>Связанный лонг вилки</h2><p className="muted">Этот бот открывается автоматически для совместного выхода с основным шортом. Его нельзя редактировать или запускать отдельно.</p><a className="btn primary" href={`#/fork/${editing.forkParentId}`}>Открыть вилку</a></div>;

  return (
    <div className="form-page">
      <form className="bot-form" onSubmit={(e) => { e.preventDefault(); submit(true); }}>
        <header className="block-head">
          <h2>{editing ? `Настройки «${editing.config.name}»` : "Новый бот"}</h2>
          <p className="muted">Счёт «{a.name}» · бумажная торговля по ценам Bybit</p>
        </header>
        {liveCycle && <p className="banner">Открытая сделка {coin(liveCycle.symbol)}: тейк, стоп, бюджет и будущие шаги сетки, подушка и защиты обновятся после сохранения. Исполненные покупки, плечо, сторона и монета текущей позиции не меняются. Выбор монет и стратегии входа действуют со следующей сделки.</p>}
        {busyBot && !liveCycle && <p className="banner">Текущая сделка закрывается или связана с вилкой. Новые настройки бота начнут действовать со следующей сделки.</p>}

        <fieldset>
          <legend>Как бот выбирает монету</legend>
          <div className="choice">
            <label className={!manual ? "on" : ""}><input type="radio" name="mode" value="auto" checked={!manual} onChange={set("mode")} /><b>Сам по сигналам</b><span>монету и направление даёт отмеченная стратегия</span></label>
            <label className={manual ? "on" : ""}><input type="radio" name="mode" value="manual" checked={manual} onChange={set("mode")} /><b>Одна монета</b><span>вы задаёте монету и сторону</span></label>
          </div>
          {manual ? (
            <div className="fields two">
              <label>Монета
                <input list="symbols" value={coin(cfg.symbol)} onChange={(e) => setCfg({ ...cfg, symbol: e.target.value.toUpperCase().replace(/USDT$/, "") + "USDT" })} />
                <datalist id="symbols">{quotes.slice(0, 200).map((q) => <option key={q.symbol} value={coin(q.symbol)} />)}</datalist>
                <small className="muted">{mark ? `сейчас ${price(mark)}` : "цены нет в выборке — проверьте тикер"}</small>
              </label>
              <label>Сторона
                <select value={cfg.direction} onChange={set("direction")}><option value="SHORT">Шорт — заработать на падении</option><option value="LONG">Лонг — заработать на росте</option></select>
              </label>
            </div>
          ) : (
            <div className="strategies">
              {cfg.stages.FLIP_RISK && riskSizing && <p className="muted note">
                При капитале {money(a.equity, 0)} расчётный бюджет одного бота {money(riskSizing.budget, 2)};
                до {riskSizing.bots} одновременно работающих ботов при свободном счёте.
                Вход 75%, одно усреднение 25%, плечо ×2, тейк 10% и стоп 15% бюджета.
                Бюджет фиксируется при выборе стратегии. После изменения капитала или числа других ботов пересчитайте общий риск.
              </p>}
              {STRATEGY_ORDER.map((k) => (
                <label key={k} className={cfg.stages[k] ? "on" : ""}>
                  <input type="checkbox" checked={!!cfg.stages[k]} onChange={(e) => selectStrategy(k, e.target.checked)} />
                  <b>{STRATEGY[k].name}</b>
                  <span>{STRATEGY[k].about}</span>
                </label>
              ))}
              {cfg.stages.DUMP_ACCEL && <p className="muted note">Для этой стратегии применены параметры исследованного варианта. Остальные стратегии сняты, поскольку они используют общие настройки бота.</p>}
              {cfg.stages.DUMP_REBOUND && <p className="muted note">Этот бот использует значения из полей ниже. После защитного выхода докупки прекращаются, а тейк по-прежнему учитывает общий результат сделки.</p>}
              <p className="muted note">Если сигналов несколько — бот берёт монету с бóльшим оборотом. По одной монете на счёте одна позиция; после закрытия по стадии повтор не раньше чем через 24 ч.</p>
            </div>
          )}
        </fieldset>

        <fieldset>
          <legend>Деньги и сетка</legend>
          <div className="fields">
            <label>Название<input value={cfg.name} onChange={set("name")} maxLength={64} required /></label>
            <label><Hint term="budget">Бюджет сетки, $</Hint><input className="num" inputMode="decimal" value={cfg.budget} onChange={set("budget")} /><small className="muted">{cfg.orderPcts ? "вход и докупки задаются в % бюджета" : "бюджет делится поровну между шагами"}</small></label>
            <label><Hint term="leverage">Плечо</Hint><input type="number" min={state.limits.leverage[0]} max={state.limits.leverage[1]} value={cfg.leverage} onChange={set("leverage")} /></label>
            <label>{cfg.orderPcts ? <Hint term="steps">Докупок сетки</Hint> : "Всего шагов сетки"}<input type="number" min={state.limits.steps[0]} max={state.limits.steps[1]} value={cfg.steps} onChange={set("steps")} />{!cfg.orderPcts && <small className="muted">включая первый вход</small>}</label>
            <label>Шаг цены сетки, %<input className="num" inputMode="decimal" value={cfg.spacingPct} onChange={(e) => setCfg((prev) => ({ ...prev, spacingPct: e.target.value.replace(",", ".") }))} /><small className="muted">Уровни докупок считаются от цены первого входа. Допустимый шаг 0,01–10%.</small></label>
            {cfg.orderPcts && <>
              <label>Первый вход, % бюджета сетки<input className="num" inputMode="decimal" value={cfg.entryPct} onChange={set("entryPct")} /><small className="muted">{money(Number(cfg.budget) * Number(cfg.entryPct) / 100)} маржи</small></label>
              <div className="order-pcts"><b>Докупки, % бюджета сетки</b><div className="fields four">{cfg.orderPcts.slice(0, cfg.steps).map((value, index) => <label key={index}>Докупка {index + 1}<input className="num" inputMode="decimal" value={value} onChange={setOrderPct(index)} /><small className="muted">{money(Number(cfg.budget) * Number(value) / 100)} маржи</small></label>)}</div><small className="muted">Первый вход и активные докупки вместе не должны превышать 100% бюджета.</small></div>
            </>}
            <label><Hint term="tp">Тейк-профит, % бюджета</Hint><input className="num" inputMode="decimal" value={cfg.tpPct} onChange={set("tpPct")} /><small className="muted">{money((Number(cfg.budget) * Number(cfg.tpPct)) / 100)} чистыми</small></label>
            <label><Hint term="sl">Стоп-лосс, % бюджета</Hint><input className="num" inputMode="decimal" value={cfg.slPct} onChange={set("slPct")} /><small className="muted">−{money((Number(cfg.budget) * Number(cfg.slPct)) / 100)}</small></label>
          </div>
        </fieldset>

        <fieldset>
          <legend>Защита позиции</legend>
          <div className="notice"><b>Вилка: связанный лонг для выхода из шорта</b><p>Для настроек в этой форме {fork?.enabled ? "включена" : "выключена"}. Пороги роста, размер цели и ограничения задаются во вкладке «Вилка».</p>{editing ? <a href={`#/fork/${editing.id}`}>Настроить вилку</a> : <small className="muted">Сначала создайте бота, затем откройте вкладку «Вилка».</small>}</div>
          <label className="check big-check"><input type="checkbox" checked={cfg.marginAuto} onChange={set("marginAuto")} />
            <span><b><Hint term="cushion">Подушка маржи</Hint></b> — если запас до ликвидации меньше 15%, бот добавит маржу со свободных средств, а при запасе больше 30% вернёт её. Рекомендуем держать включённой.</span></label>
          {cfg.marginAuto && <label className="inline"><Hint term="cushionCap">Не больше, $</Hint><input className="num" inputMode="decimal" value={cfg.marginCap} onChange={set("marginCap")} /></label>}
          <label className="check big-check"><input type="checkbox" checked={cfg.guardOn} onChange={set("guardOn")} />
            <span><b><Hint term="guard">Подстраховка от резкого движения</Hint></b> — начиная с выбранного шага сетки: если цена за короткое время резко ушла против позиции, бот перестаёт докупать и держит набранный объём. Тейк, стоп и подушка продолжают работать.</span></label>
          {cfg.guardOn && (
            <div className="fields three guard-fields">
              <label>С шага<input type="number" min={1} max={cfg.steps} value={cfg.guardStep} onChange={set("guardStep")} /><small className="muted">проверка начинается после этого шага</small></label>
              <label>Рост против позиции, %<input className="num" inputMode="decimal" value={cfg.guardPct} onChange={set("guardPct")} /><small className="muted">от лучшей цены за окно, включая цены докупок</small></label>
              <label>За время, мин<input type="number" min={5} max={240} value={cfg.guardMinutes} onChange={set("guardMinutes")} /><small className="muted">окно наблюдения, 5–240 мин</small></label>
            </div>
          )}
          <label className="check big-check"><input type="checkbox" checked={cfg.accelerationStopOn} disabled={!!(cfg.stages.DUMP_ACCEL || cfg.stages.DUMP_REBOUND)} onChange={set("accelerationStopOn")} />
            <span>Защитный выход SHORT: рост монеты за завершённый час, минимум три шага сетки и убыточное закрытие. После стопа монета исключается для всех ботов этого счёта; бот продолжает работу.</span></label>
          {cfg.accelerationStopOn && <label>Рост за час, %<input className="num" inputMode="decimal" value={cfg.accelerationStopPct} onChange={set("accelerationStopPct")} /></label>}
          <label className="check big-check"><input type="checkbox" checked={cfg.recoveryExitOn} disabled={!!cfg.stages.DUMP_REBOUND} onChange={set("recoveryExitOn")} />
            <span><b>Частичный выход при восстановлении</b> — после заданного числа исполненных шагов защита взводится при глубоком убытке. Когда общий ожидаемый чистый результат восстановится до порога выхода, бот один раз закрывает указанную долю актуального объёма и останавливает дальнейшие автоматические докупки. Тейк и стоп имеют приоритет.</span></label>
          {cfg.recoveryExitOn && (
            <div className="fields four guard-fields">
              <label>После исполненных шагов<input type="number" min={1} max={9} value={cfg.recoveryArmStep} onChange={set("recoveryArmStep")} /></label>
              <label>Взвести при результате, $<input className="num" inputMode="decimal" value={cfg.recoveryArmNet} onChange={set("recoveryArmNet")} /></label>
              <label>Выйти при восстановлении до, $<input className="num" inputMode="decimal" value={cfg.recoveryTargetNet} onChange={set("recoveryTargetNet")} /></label>
              <label>Закрыть объёма, %<input className="num" inputMode="decimal" value={cfg.recoveryExitPct} onChange={set("recoveryExitPct")} /></label>
            </div>
          )}
          {!manual && <label>Не торговать монеты<input value={excl} onChange={(e) => setExcl(e.target.value)} placeholder="Например: JCT, ARIA" /></label>}
        </fieldset>

        {err && <div className="banner">{err}</div>}
        <div className="form-actions">
          {editing ? <button className="primary" disabled={busy}>Сохранить</button> : (
            <>
              <button className="primary" disabled={busy}>Создать и запустить</button>
              <button type="button" disabled={busy} onClick={() => submit(false)}>Создать без запуска</button>
            </>
          )}
          <a className="btn ghost" href="#/bots">Отмена</a>
        </div>
      </form>

      <aside className="preview" aria-label="Расчёт сетки">
        <h3>Как пойдёт сетка</h3>
        {liveCycle && <p className="muted">Предварительный расчёт всей сетки для следующей сделки. В текущей позиции уже исполненные шаги остаются прежними.</p>}
        <p className="muted">{manual && mark ? `За цену первого входа взята текущая цена ${coin(cfg.symbol)}.` : "Уровни показаны в процентах от цены первого входа."} {dirPrev === "SHORT" ? "Для шорта докупки выше входа." : "Для лонга докупки ниже входа."} Шаг 1 — первый вход.</p>
        {rows.length > 0 && (
          <table className="ladder">
            <thead><tr><th>Шаг</th><th className="num">{manual && mark ? "Цена" : "Уровень от входа"}</th><th className="num">На шаг / маржа после комиссий</th><th className="num"><Hint term="lr">До ликвидации</Hint></th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.i}>
                  <td>{r.i + 1}</td>
                  <td className="num">{manual && mark ? price(r.p) : `${levelFormat.format(r.move)}%`}</td>
                  <td className="num">{money(r.amount, 2)} / {money(r.used, 2)}</td>
                  <td className={`num ${Math.abs(r.liqMove) < 15 ? "down" : ""}`}>{pct(Math.abs(r.liqMove))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {last && <p className="preview-sum">Последний плановый шаг на <b>{levelFormat.format(last.move)}%</b> от входа. Это расчёт при исполнении всех шагов, без подушки маржи. Стопы и защиты могут прервать сетку раньше. Плановый объём позиции до <b>{money(last.volume, 0)}</b>.</p>}
        <h3>Распределение капитала</h3>
        <div className="alloc" role="img" aria-label="Распределение капитала счёта">
          {parts.map(([l, v, cls]) => <span key={l} className={cls} style={{ width: `${Math.max(0, Math.min(100, (v / capital) * 100))}%` }} />)}
        </div>
        <dl className="alloc-legend">
          {parts.map(([l, v, cls]) => <div key={l}><dt><i className={cls} />{l}</dt><dd>{money(v, 0)}</dd></div>)}
          <div><dt><i className="seg-free" />Запас при полном использовании лимитов</dt><dd className={restFree < 0 ? "down" : ""}>{money(restFree, 0)}</dd></div>
        </dl>
        {cfg.marginAuto && <p className="muted small-note">Подушка маржи — запас свободных денег, который бот может добавить в сделку при угрозе ликвидации. Пока подушка не нужна, деньги остаются свободными.</p>}
        {restFree < 0 && <p className="down">Бюджетов и подушек больше, чем капитала: часть ботов не сможет открыть сделки или защитить позицию.</p>}
      </aside>
    </div>
  );
}
