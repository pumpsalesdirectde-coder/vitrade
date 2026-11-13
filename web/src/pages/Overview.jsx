import Equity from "../ui/Equity.jsx";
import Ruler from "../ui/Ruler.jsx";
import { coin, duration, entryLabel, money, pct, price, signed, tone, when } from "../format.js";

const EVENT = {
  FILL: "Сделка", MARGIN_ADD: "Подушка", MARGIN_RETURN: "Подушка", FUNDING: "Фандинг", COMMAND: "Команда",
  BOT_CREATED: "Бот", CAPITAL: "Счёт", LIQUIDATION_TRIGGER: "Ликвидация",
};
const COMMAND = { start: "Запуск", pause: "Пауза докупок", resume: "Докупки возобновлены", finish: "Довести и остановить", close: "Закрыть по рынку", add: "Ручная докупка", partial: "Частичная фиксация", update: "Настройки изменены" };

const FILL_TEXT = {
  "Исполнен шаг DCA": "Исполнен шаг сетки", "Ручное усреднение": "Ручная докупка",
  TAKE_PROFIT: "Закрыта по тейк-профиту", STOP_LOSS: "Закрыта по стоп-лоссу", MANUAL: "Закрыта вручную", LIQUIDATION: "Ликвидация", PARTIAL: "Частичная фиксация",
};
const message = (e) => (e.type === "COMMAND" ? COMMAND[e.message] || e.message : FILL_TEXT[e.message] || e.message.replace(/ PAPER$/, ""));

/** Вложение в позицию — нейтральная сумма; результат закрытия, фандинг и подушка — со знаком. */
function Amount({ e }) {
  const putIn = e.type === "FILL" && /шаг|докупка|усреднение/i.test(e.message);
  if (putIn || e.type === "MARGIN_ADD" || e.type === "MARGIN_RETURN" || e.type === "CAPITAL") return <span className="ev-amt">{money(e.amount)}</span>;
  return <span className={`ev-amt ${tone(e.amount)}`}>{signed(e.amount, e.type === "FUNDING" ? 3 : 2)}</span>;
}

export default function Overview({ account: a }) {
  const bots = Object.fromEntries(a.bots.map((b) => [b.id, b]));
  const positions = [...a.positions].sort((x, y) => Number(x.lr) - Number(y.lr));
  const closed = a.cycles.filter((c) => c.status === "CLOSED");
  const realized = closed.reduce((s, c) => s + Number(c.realized) + Number(c.funding) - Number(c.fees), 0);
  const wins = closed.filter((c) => Number(c.realized) + Number(c.funding) - Number(c.fees) > 0).length;

  return (
    <div className="overview">
      <section className="statement" aria-label="Состояние счёта">
        <div className="lead">
          <span className="muted">Капитал</span>
          <strong className="big">{money(a.equity)}</strong>
          <span className={`delta ${tone(a.net)}`}>{signed(a.net)} USDT с начала · {signed((Number(a.net) / Number(a.initial)) * 100, 2)}%</span>
        </div>
        <dl className="facts">
          <div><dt>Свободно</dt><dd>{money(a.free)}</dd></div>
          <div><dt>Маржа в позициях</dt><dd>{money(a.margin)}</dd></div>
          <div><dt>Плавающий результат</dt><dd className={tone(a.unrealized)}>{signed(a.unrealized)}</dd></div>
          <div><dt>Закрыто сделок</dt><dd>{closed.length} <small className="muted">в плюс {wins}</small></dd></div>
          <div><dt>Итог закрытых</dt><dd className={tone(realized)}>{signed(realized)}</dd></div>
          <div><dt>Макс. просадка</dt><dd>{pct(a.maxDrawdown, 2)}</dd></div>
        </dl>
        <Equity points={a.snapshots} initial={a.initial} />
      </section>

      <section className="block">
        <header className="block-head">
          <h2>Открытые позиции <span className="count">{positions.length}</span></h2>
          <p className="muted">Сначала — ближайшие к ликвидации. ▼ — текущая цена, тёмные метки — набранные шаги сетки.</p>
        </header>
        {positions.length === 0 ? (
          <p className="empty-line">Позиций нет. Запущенные боты откроют сделку, когда появится сигнал выбранной стратегии.</p>
        ) : (
          <ul className="positions">
            {positions.map((p) => (
              <li key={p.id} className="position">
                <div className="pos-id">
                  <strong>{coin(p.symbol)}</strong>
                  <span className={`side ${p.direction === "LONG" ? "long" : "short"}`}>{p.direction === "LONG" ? "Лонг" : "Шорт"} ×{p.config.leverage}</span>
                  <span className="muted">{bots[p.botId]?.config.name || "—"} · {entryLabel(p)}</span>
                </div>
                <dl className="pos-nums">
                  <div><dt>Цена</dt><dd>{price(p.mark)}</dd></div>
                  <div><dt>Средняя</dt><dd>{price(p.average)}</dd></div>
                  <div><dt>Шаги</dt><dd>{p.usedSteps}/{p.config.steps}</dd></div>
                  <div><dt>В сделке</dt><dd>{duration(p.openedAt)}</dd></div>
                  <div><dt>Итог</dt><dd className={tone(p.net)}><b>{signed(p.net)}</b></dd></div>
                </dl>
                <Ruler p={p} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="block">
        <header className="block-head"><h2>Журнал счёта</h2></header>
        <ol className="events">
          {a.events.slice(0, 40).map((e) => (
            <li key={e.id}>
              <time>{when(e.at)}</time>
              <span className="ev-type">{EVENT[e.type] || e.type}</span>
              <span className="ev-msg">
                {message(e)}
                {e.botId && bots[e.botId] ? <span className="muted"> · {bots[e.botId].config.name}</span> : null}
              </span>
              {e.amount && e.type !== "LIQUIDATION_TRIGGER" ? <Amount e={e} /> : <span />}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
