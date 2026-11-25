import { useState } from "react";
import TradeChart from "../ui/TradeChart.jsx";
import Period, { inRange, periodRange, usePeriod } from "../ui/Period.jsx";
import { CLOSE_REASON, coin, duration, entryLabel, money, price, signed, tone, when } from "../format.js";
import Hint from "../ui/Hint.jsx";

const result = (c, mark) => {
  const base = Number(c.realized) + Number(c.funding) - Number(c.fees);
  if (c.status === "CLOSED") return base;
  const q = Number(c.quantity);
  return base + (c.direction === "LONG" ? q * (Number(mark) - Number(c.average)) : q * (Number(c.average) - Number(mark)));
};

export default function Trades({ account: a }) {
  const [tab, setTab] = useState("open");
  const [closedFilter, setClosedFilter] = useState("all");
  const [chart, setChart] = useState(null);
  const [period, setPeriod] = usePeriod();
  const range = periodRange(period);
  const names = Object.fromEntries(a.bots.map((b) => [b.id, b.config.name]));
  const marks = Object.fromEntries(a.positions.map((p) => [p.id, p.mark]));
  // открытые попадают в период по дате открытия, закрытые — по дате закрытия
  const all = a.cycles.filter((c) => inRange(range, c.status === "CLOSED" ? c.closedAt : c.openedAt)).map((c) => ({ ...c, total: result(c, marks[c.id] ?? c.lastMark), mark: marks[c.id] ?? c.lastMark, label: entryLabel(c) }));
  const open = all.filter((c) => c.status !== "CLOSED").sort((x, y) => y.openedAt - x.openedAt);
  const closed = all.filter((c) => c.status === "CLOSED").sort((x, y) => y.closedAt - x.closedAt);
  const sum = (l) => l.reduce((s, c) => s + c.total, 0);
  const by = {};
  for (const c of all) {
    const k = c.label;
    by[k] ||= { n: 0, open: 0, win: 0, total: 0 };
    by[k].n++;
    if (c.status !== "CLOSED") by[k].open++;
    else if (c.total > 0) by[k].win++;
    by[k].total += c.total;
  }
  const list = tab === "open" ? open : closed.filter((c) => closedFilter === "all" || (closedFilter === "profit" ? c.total > 0 : c.total < 0));

  return (
    <div className="trades">
      <section className="panel period-bar"><Period value={period} onChange={setPeriod} /></section>
      <section className="block">
        <header className="block-head"><h2>Результат по стратегиям входа</h2></header>
        {Object.keys(by).length === 0 ? <p className="empty-line">Сделок ещё не было.</p> : (
          <div className="table-wrap">
            <table className="grid-table compact">
              <thead><tr><th>Стратегия</th><th className="num">Сделок</th><th className="num">Открыто</th><th className="num">Закрыто в плюс</th><th className="num">Итог, $</th><th className="bar-col" aria-hidden="true" /></tr></thead>
              <tbody>
                {Object.entries(by).sort((x, y) => y[1].total - x[1].total).map(([k, v]) => {
                  const max = Math.max(...Object.values(by).map((x) => Math.abs(x.total)), 1e-9);
                  return (
                    <tr key={k}>
                      <td><strong>{k}</strong></td>
                      <td className="num">{v.n}</td>
                      <td className="num">{v.open}</td>
                      <td className="num">{v.win} из {v.n - v.open}</td>
                      <td className={`num ${tone(v.total)}`}><b>{signed(v.total)}</b></td>
                      <td className="bar-col"><span className={`hbar ${tone(v.total)}`} style={{ width: `${(Math.abs(v.total) / max) * 100}%` }} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="block">
        <header className="block-head">
          <div className="seg big" role="tablist" aria-label="Сделки">
            <button role="tab" aria-selected={tab === "open"} onClick={() => setTab("open")}>
              Открытые <b>{open.length}</b> <span className={tone(sum(open))}>{signed(sum(open))}</span>
            </button>
            <button role="tab" aria-selected={tab === "closed"} onClick={() => setTab("closed")}>
              Закрытые <b>{closed.length}</b> <span className={tone(sum(closed))}>{signed(sum(closed))}</span>
            </button>
          </div>
          <p className="muted">Итог = результат по цене + фандинг − комиссии. Для открытых — по текущей цене Bybit.</p>
        </header>
        {tab === "closed" && <div className="seg" role="group" aria-label="Фильтр закрытых сделок">
          {[["all", "Все"], ["profit", "В плюс"], ["loss", "В минус"]].map(([key, label]) => <button key={key} type="button" aria-pressed={closedFilter === key} onClick={() => setClosedFilter(key)}>{label}</button>)}
        </div>}
        {list.length === 0 ? <p className="empty-line">{tab === "open" ? "Открытых сделок нет." : closed.length === 0 ? "Закрытых сделок пока нет." : "Нет сделок для выбранного фильтра."}</p> : (
          <div className="table-wrap">
            <table className="grid-table">
              <thead>
                <tr>
                  <th>Монета</th><th>Вход по</th><th>Бот</th><th className="num">Шаги</th><th className="num"><Hint term="anchor">Первый вход</Hint></th><th className="num"><Hint term="average">Средняя</Hint></th>
                  <th className="num">{tab === "open" ? "Цена сейчас" : "Причина"}</th><th className="num"><Hint term="byPrice">По цене</Hint></th><th className="num"><Hint term="funding">Фандинг</Hint></th><th className="num"><Hint term="fees">Комиссии</Hint></th><th className="num"><Hint term="total">Итог</Hint></th>
                  <th>{tab === "open" ? "Открыта" : "Закрыта"}</th><th>Длилась</th>
                </tr>
              </thead>
              <tbody>
                {list.map((c) => {
                  const byPrice = c.total - Number(c.funding) + Number(c.fees);
                  const pair = a.forks?.find((p) => p.id === c.forkId);
                  const related = pair && (c.direction === "LONG" ? pair.parentBotId : pair.childBotId);
                  return (
                    <tr key={c.id}>
                      <td><button className="coin-link" onClick={() => setChart(c)} title="Открыть график сделки"><strong>{coin(c.symbol)}</strong></button> <span className={`side ${c.direction === "LONG" ? "long" : "short"}`}>{c.direction === "LONG" ? "Л" : "Ш"}</span></td>
                      <td><span className="chip">{c.label}</span></td>
                      <td className="muted">{names[c.botId] || "удалён"}{pair && <a className="sub small fork-link" href={`#/fork/${pair.parentBotId}`}>Вилка: {c.direction === "LONG" ? "лонг" : "шорт"} ↔ {names[related] || "связанная сторона"}</a>}</td>
                      <td className="num">{c.usedSteps}/{c.config.steps}</td>
                      <td className="num">{price(c.anchor)}</td>
                      <td className="num">{price(c.average)}</td>
                      <td className="num">{c.status === "CLOSED" ? CLOSE_REASON[c.closeReason] || c.closeReason : price(c.mark)}</td>
                      <td className={`num ${tone(byPrice)}`}>{signed(byPrice)}</td>
                      <td className={`num ${tone(c.funding)}`}>{signed(c.funding, 3)}</td>
                      <td className="num muted">−{money(c.fees, 3)}</td>
                      <td className={`num ${tone(c.total)}`}><b>{signed(c.total)}</b></td>
                      <td>{when(c.status === "CLOSED" ? c.closedAt : c.openedAt)}</td>
                      <td>{duration(c.openedAt, c.closedAt || Date.now())}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {chart && <TradeChart account={a} cycle={chart} position={a.positions.find((p) => p.id === chart.id)} onClose={() => setChart(null)} />}
    </div>
  );
}
