import { useCallback, useEffect, useRef, useState } from "react";
import { get, post } from "../api.js";
import { money, price, signed, tone, when } from "../format.js";

const URL = "/api/range-paper";
const USDT = "\u00a0USDT";
const RECENT_TRADES = 40;
const REASONS = {
  TAKE_PROFIT: "Цель",
  STOP: "Стоп",
  LIQUIDATION: "Модельная ликвидация",
  TURN_TIMEOUT: "Лимит времени сделки",
  RANGE_TIMEOUT: "Истёк срок диапазона",
  BREAKOUT: "Пробой диапазона",
  DATA_GAP: "Разрыв данных",
  DISABLED: "Отключение режима",
};

function usePaperBook() {
  const [book, setBook] = useState(null);
  const [pollError, setPollError] = useState("");
  const [commandError, setCommandError] = useState("");
  const [pending, setPending] = useState(false);
  const active = useRef(false);
  const reading = useRef(false);
  const writing = useRef(false);
  const version = useRef(0);

  const reload = useCallback(async () => {
    if (!active.current || reading.current || writing.current) return;
    const requestVersion = version.current;
    reading.current = true;
    try {
      const next = await get(URL);
      if (!active.current || requestVersion !== version.current) return;
      setBook(next);
      setPollError("");
    } catch (error) {
      if (active.current && requestVersion === version.current) setPollError(error.message);
    } finally {
      reading.current = false;
    }
  }, []);

  useEffect(() => {
    active.current = true;
    void reload();
    const timer = setInterval(reload, 5000);
    return () => {
      active.current = false;
      version.current++;
      clearInterval(timer);
    };
  }, [reload]);

  const configure = async (configuration) => {
    if (!active.current || writing.current) return false;
    writing.current = true;
    version.current++;
    setPending(true);
    setCommandError("");
    let needsReload = false;
    try {
      const next = await post(URL, configuration);
      if (active.current) {
        setBook(next);
        setPollError("");
      }
      return true;
    } catch (error) {
      if (active.current) {
        setCommandError(error.message);
        setPollError("Обновляем состояние режима…");
      }
      needsReload = true;
      return false;
    } finally {
      writing.current = false;
      if (active.current) setPending(false);
      if (needsReload) void reload();
    }
  };

  return { book, pollError, commandError, pending, configure, reload };
}

function Side({ direction }) {
  const long = direction === "LONG";
  return <span className={`side ${long ? "long" : "short"}`}>{long ? "Лонг" : "Шорт"}</span>;
}

function BookStatus({ book, draining }) {
  const stale = book.marketAt > 0 && Date.now() - book.marketAt > 30_000;
  if (draining) return <span className="state busy" role="status">Закрывает позиции</span>;
  if (!book.enabled) return <span className="state off" role="status">Выключен</span>;
  if (stale || book.status === "stale") return <span className="state hold" role="status">Ждёт свежих котировок</span>;
  if (book.status === "scanning") return <span className="state live" role="status">Сканирует рынок</span>;
  return <span className="state wait" role="status">Собирает свечи</span>;
}

function Positions({ rows }) {
  return (
    <section className="panel">
      <h2 className="panel-title">Открытые позиции <span className="count">{rows.length}</span></h2>
      {rows.length === 0 ? <p className="empty-line">Открытых позиций нет.</p> :
        <div className="table-wrap"><table className="grid-table compact">
          <thead><tr><th>Монета</th><th>Сторона</th><th>Оборот</th><th>Открыта</th><th className="num">Номинал</th><th className="num">Вход</th><th className="num">Mark price</th></tr></thead>
          <tbody>{rows.map((row) => (
            <tr key={row.id ?? row.symbol}>
              <td data-label="Монета"><b>{row.symbol}</b></td>
              <td data-label="Сторона"><Side direction={row.direction} /></td>
              <td data-label="Оборот">{row.turn ?? "—"}</td>
              <td data-label="Открыта">{when(row.openedAt)}</td>
              <td className="num" data-label="Номинал">{money(row.notional, 2, USDT)}</td>
              <td className="num" data-label="Вход">{price(row.entryPrice, "")}</td>
              <td className="num" data-label="Mark price" title={row.markAt ? `Котировка: ${when(row.markAt)}` : undefined}>{price(row.mark, "")}</td>
            </tr>
          ))}</tbody>
        </table></div>}
    </section>
  );
}

function Journal({ rows }) {
  const recent = [...rows].sort((a, b) => b.closedAt - a.closedAt).slice(0, RECENT_TRADES);
  return (
    <section className="panel">
      <header className="panel-head">
        <h2 className="panel-title">Журнал закрытий</h2>
        <span className="muted small">Итог с комиссией, спредом, проскальзыванием и известным фандингом</span>
      </header>
      {recent.length === 0 ? <p className="empty-line">Закрытых сделок пока нет.</p> :
        <div className="table-wrap"><table className="grid-table compact">
          <thead><tr><th>Монета</th><th>Сторона</th><th>Закрыта</th><th>Причина</th><th className="num">Вход</th><th className="num">Выход</th><th className="num">Чистый PnL</th></tr></thead>
          <tbody>{recent.map((row) => (
            <tr key={row.id ?? `${row.symbol}:${row.openedAt}`}>
              <td data-label="Монета"><b>{row.symbol}</b></td>
              <td data-label="Сторона"><Side direction={row.direction} /></td>
              <td data-label="Закрыта" title={`Открыта: ${when(row.openedAt)}`}>{when(row.closedAt)}</td>
              <td data-label="Причина">{REASONS[row.reason] ?? row.reason ?? "—"}</td>
              <td className="num" data-label="Вход">{price(row.entryPrice, "")}</td>
              <td className="num" data-label="Выход">{price(row.exitPrice, "")}</td>
              <td className={`num ${tone(row.net)}`} data-label="Чистый PnL">{signed(row.net, 2, USDT)}</td>
            </tr>
          ))}</tbody>
        </table></div>}
      {rows.length > RECENT_TRADES && <p className="muted small">Показано {RECENT_TRADES} последних сделок.</p>}
    </section>
  );
}

export default function RangePaper() {
  const { book, pollError, commandError, pending, configure, reload } = usePaperBook();
  const [choices, setChoices] = useState(null);
  if (!book) return pollError ?
    <div className="empty-state"><p role="alert">{pollError}</p><button type="button" onClick={reload}>Повторить</button></div> :
    <p className="muted" role="status">Загрузка PAPER-счёта…</p>;

  const positions = book.positions ?? [];
  const trades = book.trades ?? [];
  const draining = book.status === "draining" || (!book.enabled && positions.length > 0);
  const locked = book.enabled || draining;
  const selection = locked || !choices ? { direction: book.direction, regime: book.regime } : choices;
  const net = Number(book.equity) - Number(book.initial);

  const toggle = async (event) => {
    event.preventDefault();
    if (pending || draining || (!book.enabled && pollError)) return;
    if (await configure({ enabled: !book.enabled, ...selection })) setChoices(null);
  };

  return (
    <div>
      <section className="statement" aria-label="Изолированный виртуальный счёт">
        <div className="lead">
          <span className="muted">Капитал PAPER-счёта</span>
          <strong className="big">{money(book.equity, 2, USDT)}</strong>
          <span className={`delta ${tone(net)}`}>{signed(net, 2, USDT)} с начала</span>
        </div>
        <dl className="facts">
          <div><dt>Стартовый баланс</dt><dd>{money(book.initial, 0, USDT)}</dd></div>
          <div><dt>Свободные средства</dt><dd>{money(book.cash, 2, USDT)}</dd></div>
          <div><dt>Маржа в позициях</dt><dd>{money(book.usedMargin, 2, "")} / {money(book.budget, 0, USDT)}</dd></div>
          <div><dt>Плечо · лимит номинала</dt><dd>×{book.leverage} · {money(book.budget * book.leverage, 0, USDT)}</dd></div>
        </dl>
      </section>
      <section className="panel stack" aria-label="Управление стратегией">
        <header className="toolbar">
          <h2>Режим PAPER</h2>
          <BookStatus book={book} draining={draining} />
        </header>
        <p className="muted">Отдельный виртуальный счёт с котировками Bybit. Второй вход требует нового колебания через середину диапазона.</p>
        <form className="stack" onSubmit={toggle}>
          <div className="fields two">
            <label>Сторона
              <select value={selection.direction} disabled={locked || pending} onChange={(e) => setChoices({ ...selection, direction: e.target.value })}>
                <option value="LONG">Лонг</option>
                <option value="SHORT">Шорт</option>
              </select>
            </label>
            <label>Тип диапазона
              <select value={selection.regime} disabled={locked || pending} onChange={(e) => setChoices({ ...selection, regime: e.target.value })}>
                <option value="impulse">После импульса</option>
                <option value="quiet">Без импульса</option>
              </select>
            </label>
          </div>
          <div className="toolbar">
            <button type="submit" className={`btn ${book.enabled ? "danger" : "primary"}`} disabled={pending || draining || (!book.enabled && !!pollError)}>
              {pending ? "Сохранение…" : draining ? "Ожидается закрытие" : book.enabled ? "Остановить PAPER" : "Запустить PAPER"}
            </button>
          </div>
        </form>
        {book.enabled && <p className="muted small">При остановке новые входы прекращаются. Открытые позиции закрываются по свежим котировкам.</p>}
        {draining && <p className="muted small">В режиме остановки ждём свежих котировок, чтобы закрыть позиции.</p>}
        {book.marketAt > 0 && <p className="muted small">Котировки Bybit: {when(book.marketAt)}{Number.isInteger(book.scanCount) ? ` · в сканере ${book.scanCount}` : ""}</p>}
        {book.fundingPending > 0 && <p className="muted small">Ожидаются начисления фандинга: {book.fundingPending}.</p>}
        {commandError && <p className="banner" role="alert">{commandError}</p>}
        {pollError && <p className="banner" role="status">{pollError}</p>}
      </section>
      <Positions rows={positions} />
      <Journal rows={trades} />
    </div>
  );
}
