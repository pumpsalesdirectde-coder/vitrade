import { useEffect, useReducer, useState } from "react";
import { post } from "../api.js";
import { activeFork, createForkDraft, forkDraftDirty, forkDraftReducer } from "../fork-state.js";
import { coin, duration, forkReason, money, pct, price, signed, tone, when } from "../format.js";

const result = (value) => value === null || value === undefined ? "—" : signed(value);
const quantity = (value, symbol) => value == null || !Number.isFinite(Number(value)) ? "—" : `${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 12 }).format(Number(value))} ${coin(symbol)}`;

function Facts({ rows }) {
  return <dl className="fork-facts">{rows.map(([label, value, cls]) => <div key={label}><dt>{label}</dt><dd className={cls || ""}>{value}</dd></div>)}</dl>;
}

function ForkSettings({ account: a, bot: b, defaults, refresh }) {
  const savedSettings = { ...defaults, ...b.config.fork };
  const savedJSON = JSON.stringify(savedSettings);
  const [draft, dispatch] = useReducer(forkDraftReducer, savedSettings, createForkDraft);
  const cfg = draft.settings;
  const dirty = forkDraftDirty(draft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [preview, setPreview] = useState(null);
  const [previewError, setPreviewError] = useState("");
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewVersion, setPreviewVersion] = useState(0);
  const cycle = a.positions.find((c) => c.botId === b.id && c.status !== "CLOSED");
  const pair = activeFork(a.forks, b.id);
  const short = cycle?.direction === "SHORT" ? cycle : null;
  const cfgJSON = JSON.stringify(cfg);
  const previewPosition = short ? `${short.id}:${short.quantity}:${short.average}` : "";
  const inheritedStep = short?.config?.spacingPct ?? b.config.spacingPct;
  const inheritedLeverage = short?.config?.leverage ?? b.config.leverage;
  const budget = Number(short?.config?.budget ?? b.config.budget);

  useEffect(() => dispatch({ type: "sync", settings: JSON.parse(savedJSON) }), [savedJSON]);

  useEffect(() => {
    let cancelled = false;
    setPreview(null);
    setPreviewError("");
    if (!previewPosition || pair) { setPreviewBusy(false); return undefined; }
    setPreviewBusy(true);
    const timer = setTimeout(async () => {
      try {
        const plan = await post(`/api/accounts/${a.id}/bots/${b.id}/fork-preview`, { settings: JSON.parse(cfgJSON) });
        if (!cancelled) setPreview({ ...plan, at: Date.now() });
      } catch (e) {
        if (!cancelled) setPreviewError(e.message);
      } finally {
        if (!cancelled) setPreviewBusy(false);
      }
    }, 400);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [a.id, b.id, cfgJSON, previewPosition, pair?.id, previewVersion]);

  const change = (key, value) => {
    dispatch({ type: "edit", key, value });
    setMessage("");
  };
  const field = (key, label, min, max, integer = false, note = null) => (
    <label>{label}<input type="number" inputMode={integer ? "numeric" : "decimal"} min={min} max={max} step={integer ? 1 : "any"} required value={cfg[key] ?? ""}
      onChange={(e) => change(key, integer && e.target.value !== "" ? Number(e.target.value) : e.target.value)} />{note && <small className="muted">{note}</small>}</label>
  );
  const save = async (e) => {
    e.preventDefault();
    const submitted = { ...cfg };
    setBusy(true); setError(""); setMessage("");
    try {
      await post(`/api/accounts/${a.id}/bots/${b.id}/commands`, { action: "fork-settings", payload: submitted });
      dispatch({ type: "saved", settings: submitted });
      setMessage("Настройки вилки сохранены");
      await refresh();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  return <div className="form-page fork-layout">
    <form className="bot-form fork-form" onSubmit={save}>
      <header className="block-head"><h2>Настройки «{b.config.name}»</h2><p className="muted">Для новых пар. У открытой пары параметры зафиксированы до выхода.</p></header>
      <fieldset>
        <legend>Автоматический запуск</legend>
        <label className="check big-check"><input type="checkbox" checked={!!cfg.enabled} onChange={(e) => change("enabled", e.target.checked)} /><span><b>Включить вилку</b><small className="sub muted">Открыть связанный лонг для убыточного шорта при любом из двух условий ниже.</small></span></label>
        <div className="fields two">
          {field("rapidPct", "Быстрый рост, %", 0.01, 1000, false, "От минимума свежих цен в окне")}
          {field("windowSeconds", "Окно наблюдения, секунд", 5, 14400, true, "После разрыва котировок окно собирается заново")}
        </div>
        <div className="fork-or"><span>ИЛИ</span></div>
        {field("totalPct", "Общий рост от первого входа, %", 0.01, 1000, false, "Первый вход не меняется после докупок")}
        {!cfg.enabled && <p className="muted small">Новые вилки отключены. Уже открытая пара продолжает сопровождаться до выхода.</p>}
      </fieldset>
      <fieldset>
        <legend>Цель совместного выхода</legend>
        <label className="check"><input type="checkbox" checked={cfg.stepPct === null} onChange={(e) => change("stepPct", e.target.checked ? null : String(inheritedStep))} /><span>Наследовать шаг сетки шорта: <b>{pct(inheritedStep, 2)}</b></span></label>
        {cfg.stepPct !== null && field("stepPct", "Следующий шаг роста, %", 0.01, 100, false, "От цены в момент открытия вилки")}
        {field("lossPct", "Допустимый общий убыток, % бюджета", 0, 100, false, `${money(budget * Number(cfg.lossPct) / 100)} · 0% — выход в безубыток`)}
        <p className="muted small">Размер лонга рассчитывается по всему оставшемуся шорту с учётом комиссий обеих позиций и комиссии кошелька.</p>
      </fieldset>
      <fieldset>
        <legend>Плечо и лимит маржи лонга</legend>
        <label className="check"><input type="checkbox" checked={cfg.leverage === null} onChange={(e) => change("leverage", e.target.checked ? null : Number(inheritedLeverage))} /><span>Наследовать плечо шорта: <b>×{inheritedLeverage}</b></span></label>
        {cfg.leverage !== null && field("leverage", "Плечо лонга", 1, 10, true)}
        <label>Лимит маржи<select value={cfg.capMode} onChange={(e) => change("capMode", e.target.value)}><option value="multiple">В долях бюджета шорт-бота</option><option value="fixed">Фиксированная сумма</option></select></label>
        {cfg.capMode === "multiple"
          ? field("capMultiple", "Множитель бюджета", 0.01, 1000, false, `Лимит ${money(budget * Number(cfg.capMultiple))}. Это лимит маржи, а не размер лонга.`)
          : field("capAmount", "Максимальная маржа лонга, $", 1, 10000000)}
        <p className="muted small">Если полного расчётного лонга не хватает по средствам или лимиту, вилка не открывается.</p>
      </fieldset>
      <fieldset>
        <legend>Выход при развороте и по времени</legend>
        <div className="fields two">
          {field("extraLossPct", "Дополнительный убыток, % бюджета", 0.01, 100, false, `${money(budget * Number(cfg.extraLossPct) / 100)} сверх результата сразу после открытия пары`)}
          {field("maxMinutes", "Максимальное время пары, минут", 1, 1440, true)}
        </div>
      </fieldset>
      {error && <p className="banner" role="alert">{error}</p>}
      <div className="form-actions"><button className="primary" disabled={busy}>{busy ? "Сохранение…" : "Сохранить настройки"}</button><span className="muted small" role="status">{dirty ? "Есть несохранённые изменения" : message}</span></div>
    </form>

    <aside className="preview fork-preview" aria-label="Расчёт вилки">
      <div className="panel-head"><h2>Расчёт лонга</h2>{short && !pair && <button type="button" disabled={previewBusy} onClick={() => setPreviewVersion((v) => v + 1)}>Обновить</button>}</div>
      {pair ? <p className="notice">Пара уже открыта. Её фиксированная цель и текущий результат показаны ниже. Изменённые настройки будут действовать для следующей вилки.</p>
        : !short ? <p className="muted">{cycle ? "Сейчас у бота открыт лонг. Расчёт появится для открытого шорта." : "У бота нет открытого шорта. Настройки можно сохранить заранее; расчёт появится после входа."}</p>
          : <>
            <p className="muted">{coin(short.symbol)} · расчёт по введённым настройкам{dirty ? " (ещё не сохранены)" : ""}. Сам расчёт не открывает лонг: для запуска нужно выполнить условие роста.</p>
            <Facts rows={[["Совокупный шорт", quantity(short.quantity, short.symbol)], ["Средняя цена шорта", price(short.average)]]} />
            {previewBusy && <p className="muted" role="status">Рассчитываем по свежей котировке…</p>}
            {previewError && <p className="banner" role="alert">{previewError}</p>}
            {preview && <>
              <p className={preview.ok ? "fork-ready" : "notice"}>{forkReason(preview.reason)}</p>
              {preview.longQuantity !== undefined && <>
                <h3>Необходимая позиция</h3>
                <Facts rows={[["Лонг, монет", quantity(preview.longQuantity, short.symbol)], ["Объём лонга", money(preview.longNotional)], ["Маржа лонга", money(preview.margin)], ["Доступно для вилки", money(preview.available)], ["Лимит маржи", money(preview.cap)], ["Плечо лонга", `×${preview.leverage}`]]} />
              </>}
              {preview.targetPrice !== undefined && <>
                <h3>На следующем шаге +{pct(preview.stepPct, 2)}</h3>
                <Facts rows={[["Целевая цена", price(preview.targetPrice)], ["Допустимый итог", result(preview.targetNet)], ["Шорт после торговых затрат", result(preview.shortNet), tone(preview.shortNet)], ["Лонг после торговых затрат", result(preview.longNet), tone(preview.longNet)], ["Комиссия кошелька, 20% от прибыли сторон", preview.platformFee == null ? "—" : `−${money(preview.platformFee)}`], ["Общий итог: счёт + кошелёк", result(preview.net), tone(preview.net)]]} />
              </>}
              <p className="muted small">Снимок расчёта: {when(preview.at)}. Обновите его после изменения цены.</p>
            </>}
          </>}
      <h3>Как закрывается пара</h3>
      <p>Обе позиции закрываются, когда их общий результат достигает допустимого убытка или лучше, а также по дополнительному стопу, времени или вручную. После выхода оба бота останавливаются.</p>
      <p className="muted small">Прогноз учитывает известный фандинг и текущий спред. Касание целевой цены не гарантирует результат: выход проверяется по исполнимым bid/ask. При развороте большой лонг увеличивает убыток.</p>
      {b.forkStatus && <p className="notice">Последнее состояние: {forkReason(typeof b.forkStatus === "string" ? b.forkStatus : b.forkStatus.reason || b.forkStatus.status)}</p>}
    </aside>
  </div>;
}

function PairCard({ pair, account: a, refresh }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const closed = pair.status === "CLOSED";
  const closing = pair.status === "CLOSING";
  const parent = a.bots.find((b) => b.id === pair.parentBotId);
  const child = a.bots.find((b) => b.id === pair.childBotId);
  const short = a.cycles.find((c) => c.id === pair.shortCycleId);
  const long = a.cycles.find((c) => c.id === pair.longCycleId);
  const close = async () => {
    if (!confirm(`Закрыть обе позиции ${coin(pair.symbol)} по рынку и остановить обоих ботов?`)) return;
    setBusy(true); setError("");
    try {
      await post(`/api/accounts/${a.id}/bots/${pair.parentBotId}/commands`, { action: "close", payload: {} });
      await refresh();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  return <article className={`panel fork-pair ${closed ? "closed" : ""}`}>
    <header className="panel-head"><div><h3>{coin(pair.symbol)} <span className={`chip ${closed ? "" : "paper-chip"}`}>{closed ? "Закрыта" : closing ? "Закрывается" : "Пара открыта"}</span></h3><p className="muted small">{when(pair.openedAt)} · {duration(pair.openedAt, pair.closedAt || Date.now())}{closed && ` · выход ${when(pair.closedAt)}`}</p></div>{!closed && <button className="danger" disabled={busy || closing} onClick={close}>{busy ? "Отправка…" : closing ? "Ожидается закрытие" : "Закрыть обе позиции"}</button>}</header>
    <div className="fork-members"><a href={`#/fork/${pair.parentBotId}`}><span className="side short">Шорт</span> {parent?.config.name || short?.config?.name || "Основной бот"}</a><span aria-hidden="true">↔</span><span><span className="side long">Лонг</span> {child?.config.name || long?.config?.name || "Связанный лонг"}</span></div>
    {pair.trigger && <p className="muted small">Условие запуска: {forkReason(pair.trigger)}</p>}
    <Facts rows={[["Целевая цена", price(pair.targetPrice)], ["Допустимый итог", result(pair.targetNet)], ["Шорт", result(pair.shortNet), tone(pair.shortNet)], ["Лонг", result(pair.longNet), tone(pair.longNet)], [closed ? "Результат торгового счёта" : "Торговый счёт при закрытии", result(pair.tradingNet), tone(pair.tradingNet)], ["Комиссия кошелька", pair.platformFee == null ? "—" : `−${money(pair.platformFee)}`]]} />
    <div className="fork-total"><span>{closed ? "Итог пары" : "Общий результат при закрытии"}<small className="sub muted">Торговый счёт + кошелёк</small></span><strong className={tone(pair.net)}>{result(pair.net)}</strong></div>
    {pair.settings && <p className="muted small">Лимит доп. убытка {money(Number(pair.budget) * Number(pair.settings.extraLossPct) / 100)} от начального результата {result(pair.baselineNet)} · максимум {pair.settings.maxMinutes} мин</p>}
    {pair.plan && <details className="fork-plan"><summary>Зафиксированный расчёт при открытии</summary><Facts rows={[["Совокупный шорт", quantity(pair.plan.shortQuantity, pair.symbol)], ["Средняя цена шорта", price(pair.plan.shortAverage)], ["Расчётный лонг", quantity(pair.plan.longQuantity, pair.symbol)], ["Объём лонга", money(pair.plan.longNotional)], ["Маржа лонга", money(pair.plan.margin)], ["Плечо лонга", `×${pair.plan.leverage}`], ["Ожидаемый общий итог у цели", result(pair.plan.net)]]} /></details>}
    {!closed && pair.executable === false && <p className="notice">Нет свежей исполнимой котировки. Результат и закрытие ожидают обновления рынка.</p>}
    {pair.closeReason && <p className="small">{closing ? "Причина закрытия" : "Причина выхода"}: {forkReason(pair.closeReason)}</p>}
    {error && <p className="banner" role="alert">{error}</p>}
  </article>;
}

export default function Fork({ account: a, accounts = [a], onPick, state, botId, refresh }) {
  const [selected, setSelected] = useState(botId || "");
  const [historyOpen, setHistoryOpen] = useState(false);
  useEffect(() => { if (botId) setSelected(botId); }, [botId]);
  const parents = a.bots.filter((b) => !b.forkParentId);
  const bot = parents.find((b) => b.id === selected) || parents[0];
  const pairs = [...(a.forks || [])].sort((x, y) => y.openedAt - x.openedAt);
  const active = pairs.filter((p) => p.status !== "CLOSED");
  const history = pairs.filter((p) => p.status === "CLOSED");

  return <div className="fork-page">
    <section className="panel fork-intro"><div><h2>Шорт и лонг с общей целью выхода</h2><p className="muted">Лонг рассчитывается под следующий шаг роста цены. По умолчанию вилка выключена — включите её для нужного бота ниже.</p></div><span className="chip paper-chip">Paper</span></section>
    <section className="panel fork-selection" aria-label="Выбор счёта и бота">
      <div className="fields two">
        <label>Счёт для вилки<select value={a.id} onChange={(e) => onPick(e.target.value)}>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>
        {bot && <label>Основной бот<select value={bot.id} onChange={(e) => { setSelected(e.target.value); location.hash = `#/fork/${e.target.value}`; }}>{parents.map((b) => <option key={b.id} value={b.id}>{b.config.name} · бюджет {money(b.config.budget, 0)}</option>)}</select></label>}
      </div>
      <p className="muted small">Выберите счёт, затем его бота. Настройки сохраняются отдельно для каждого бота.</p>
    </section>
    {bot ? <ForkSettings key={`${a.id}:${bot.id}`} account={a} bot={bot} defaults={state.defaults.fork} refresh={refresh} />
      : <div className="empty-state"><h2>Создайте основного бота</h2><p className="muted">Настройки вилки относятся к шортам основного бота. Связанный лонг появится автоматически при выполнении условия.</p><a className="btn primary" href="#/new">Создать бота</a></div>}
    <section className="fork-pairs"><header className="block-head"><h2>Активные пары <span className="count">{active.length}</span></h2><p className="muted">Все пары выбранного счёта. Докупки и частичные закрытия в паре отключены.</p></header>{active.length ? <div className="fork-pair-grid">{active.map((pair) => <PairCard key={pair.id} pair={pair} account={a} refresh={refresh} />)}</div> : <p className="muted">Активных пар пока нет.</p>}</section>
    <section className="fork-pairs"><div className="panel-head"><h2>История пар <span className="count">{history.length}</span></h2>{history.length > 0 && <button onClick={() => setHistoryOpen((v) => !v)} aria-expanded={historyOpen}>{historyOpen ? "Свернуть" : "Показать историю"}</button>}</div>{history.length === 0 ? <p className="muted">Здесь появятся результат и причина выхода каждой закрытой пары.</p> : historyOpen && <div className="fork-pair-grid">{history.map((pair) => <PairCard key={pair.id} pair={pair} account={a} refresh={refresh} />)}</div>}</section>
  </div>;
}
