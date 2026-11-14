import { useEffect, useMemo, useState } from "react";
import { get, post } from "../api.js";
import { STRATEGY, STRATEGY_ORDER, coin, money, pct, price } from "../format.js";
import Hint from "../ui/Hint.jsx";

/**
 * Расчёт сетки на условной цене входа 100 (или текущей цене монеты для ручного бота):
 * цена каждого шага, средняя, ликвидация после шага и цена тейк-профита.
 */
function ladder(cfg, entry) {
  const steps = Number(cfg.steps);
  const budget = Number(cfg.budget);
  const lev = Number(cfg.leverage);
  const sp = Number(cfg.spacingPct) / 100;
  const fee = Number(cfg.feeRate);
  const dir = cfg.direction === "LONG" ? -1 : 1; // направление, куда идёт цена против позиции
  if (!(steps > 0 && budget > 0 && lev > 0 && sp > 0 && entry > 0)) return [];
  let qty = 0;
  let cost = 0;
  let margin = 0;
  const rows = [];
  for (let i = 0; i < steps; i++) {
    const p = entry * (1 + dir * sp * i);
    const amount = budget / steps;
    const q = (amount * lev) / p;
    qty += q;
    cost += q * p;
    margin += amount - q * p * fee;
    const avg = cost / qty;
    const liq = cfg.direction === "LONG" ? (cost - margin) / (qty * 0.995) : (cost + margin) / (qty * 1.005);
    const target = (budget * Number(cfg.tpPct)) / 100;
    const tp = cfg.direction === "LONG" ? avg + target / qty : avg - target / qty;
    rows.push({ i, p, move: (p / entry - 1) * 100, used: amount * (i + 1), volume: cost, avg, liq, liqMove: (liq / p - 1) * 100, tp });
  }
  return rows;
}

const pickConfig = (c) => ({
  name: c.name, mode: c.mode, symbol: c.symbol, direction: c.direction, budget: String(c.budget), leverage: Number(c.leverage),
  steps: Number(c.steps), spacingPct: String(c.spacingPct), tpPct: String(c.tpPct), slPct: String(c.slPct),
  feeRate: String(c.feeRate), slippageRate: String(c.slippageRate), marginAuto: !!c.marginAuto, marginCap: String(c.marginCap),
  exclusions: c.exclusions || [], stages: { ...c.stages },
  guardOn: c.guardOn === true, guardStep: Number(c.guardStep ?? 3), guardPct: String(c.guardPct ?? "20"), guardMinutes: Number(c.guardMinutes ?? 60),
});

export default function BotForm({ account: a, state, botId, refresh }) {
  const editing = a.bots.find((b) => b.id === botId);
  const [cfg, setCfg] = useState(() => pickConfig(editing ? editing.config : { ...state.defaults, name: `Бот ${a.bots.length + 1}` }));
  const [excl, setExcl] = useState((editing?.config.exclusions || state.defaults.exclusions).map(coin).join(", "));
  const [quotes, setQuotes] = useState([]);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    get("/api/market").then((m) => setQuotes(m.quotes)).catch(() => {});
  }, []);
  const set = (k) => (e) => setCfg({ ...cfg, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.type === "number" ? Number(e.target.value) : e.target.value });
  const manual = cfg.mode === "manual";
  const mark = Number(quotes.find((q) => q.symbol === cfg.symbol)?.mark || 0);
  const entry = manual && mark ? mark : 100;
  // У авто-бота сторону задаёт стратегия: лонг только у «Отскока» и RSI-лонга.
  const shortPicked = ["RSI_SHORT", "PUMP", "EARLY", "FLIP", "DUMP"].some((k) => cfg.stages[k]);
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
  const busyBot = editing && editing.currentCycleId;

  const submit = async (start) => {
    setBusy(true);
    try {
      const config = { ...cfg, exclusions: excl.split(/[\s,;]+/).filter(Boolean).map((s) => s.toUpperCase().replace(/USDT$/, "") + "USDT") };
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

  return (
    <div className="form-page">
      <form className="bot-form" onSubmit={(e) => { e.preventDefault(); submit(true); }}>
        <header className="block-head">
          <h2>{editing ? `Настройки «${editing.config.name}»` : "Новый бот"}</h2>
          <p className="muted">Счёт «{a.name}» · бумажная торговля по ценам Bybit{busyBot ? " · у бота открыта сделка: новые параметры применятся со следующей" : ""}</p>
        </header>

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
              {STRATEGY_ORDER.map((k) => (
                <label key={k} className={cfg.stages[k] ? "on" : ""}>
                  <input type="checkbox" checked={!!cfg.stages[k]} onChange={(e) => setCfg({ ...cfg, stages: { ...cfg.stages, [k]: e.target.checked } })} />
                  <b>{STRATEGY[k].name}</b>
                  <span>{STRATEGY[k].about}</span>
                </label>
              ))}
              <p className="muted note">Если сигналов несколько — бот берёт монету с бóльшим оборотом. По одной монете на счёте одна позиция; после закрытия по стадии повтор не раньше чем через 24 ч.</p>
            </div>
          )}
        </fieldset>

        <fieldset>
          <legend>Деньги и сетка</legend>
          <div className="fields">
            <label>Название<input value={cfg.name} onChange={set("name")} maxLength={64} required /></label>
            <label><Hint term="budget">Бюджет сетки, $</Hint><input className="num" inputMode="decimal" value={cfg.budget} onChange={set("budget")} /><small className="muted">делится поровну на все шаги</small></label>
            <label><Hint term="leverage">Плечо</Hint><input type="number" min={state.limits.leverage[0]} max={state.limits.leverage[1]} value={cfg.leverage} onChange={set("leverage")} /></label>
            <label><Hint term="steps">Шагов сетки</Hint><input type="number" min={state.limits.steps[0]} max={state.limits.steps[1]} value={cfg.steps} onChange={set("steps")} /></label>
            <label><Hint term="spacing">Шаг сетки, %</Hint><input className="num" inputMode="decimal" value={cfg.spacingPct} onChange={set("spacingPct")} /><small className="muted">расстояние от первого входа до каждой следующей докупки</small></label>
            <label><Hint term="tp">Тейк-профит, % бюджета</Hint><input className="num" inputMode="decimal" value={cfg.tpPct} onChange={set("tpPct")} /><small className="muted">{money((Number(cfg.budget) * Number(cfg.tpPct)) / 100)} чистыми</small></label>
            <label><Hint term="sl">Стоп-лосс, % бюджета</Hint><input className="num" inputMode="decimal" value={cfg.slPct} onChange={set("slPct")} /><small className="muted">−{money((Number(cfg.budget) * Number(cfg.slPct)) / 100)}</small></label>
          </div>
        </fieldset>

        <fieldset>
          <legend>Защита позиции</legend>
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
        <p className="muted">{manual && mark ? `От текущей цены ${coin(cfg.symbol)}.` : "В процентах от цены первого входа."} {dirPrev === "SHORT" ? "Расчёт для шорта: докупки выше входа." : "Расчёт для лонга: докупки ниже входа."}</p>
        {rows.length > 0 && (
          <table className="ladder">
            <thead><tr><th>Шаг</th><th className="num">{manual && mark ? "Цена" : "Движение"}</th><th className="num">Вложено</th><th className="num"><Hint term="lr">До ликвидации</Hint></th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.i}>
                  <td>{r.i + 1}</td>
                  <td className="num">{manual && mark ? price(r.p) : (r.move > 0 ? "+" : "") + pct(r.move)}</td>
                  <td className="num">{money(r.used, 0)}</td>
                  <td className={`num ${Math.abs(r.liqMove) < 15 ? "down" : ""}`}>{pct(Math.abs(r.liqMove))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {last && (
          <p className="preview-sum">Вся сетка покрывает движение на <b>{pct(Math.abs(last.move))}</b> против позиции. После последнего шага ликвидация ещё на <b>{pct(Math.abs(last.liqMove))}</b> дальше. Объём позиции до <b>{money(last.volume, 0)}</b>.</p>
        )}
        <h3>Распределение капитала</h3>
        <div className="alloc" role="img" aria-label="Распределение капитала счёта">
          {parts.map(([l, v, cls]) => <span key={l} className={cls} style={{ width: `${Math.max(0, Math.min(100, (v / capital) * 100))}%` }} />)}
        </div>
        <dl className="alloc-legend">
          {parts.map(([l, v, cls]) => <div key={l}><dt><i className={cls} />{l}</dt><dd>{money(v, 0)}</dd></div>)}
          <div><dt><i className="seg-free" />Останется свободно</dt><dd className={restFree < 0 ? "down" : ""}>{money(restFree, 0)}</dd></div>
        </dl>
        {cfg.marginAuto && <p className="muted small-note">Подушка маржи — запас свободных денег, который бот может добавить в сделку при угрозе ликвидации. Пока подушка не нужна, деньги остаются свободными.</p>}
        {restFree < 0 && <p className="down">Бюджетов и подушек больше, чем капитала: часть ботов не сможет открыть сделки или защитить позицию.</p>}
      </aside>
    </div>
  );
}
