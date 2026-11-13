import { useState } from "react";
import { CLOSE_REASON, coin, duration, entryLabel, money, price, signed, tone, when } from "../format.js";

const result = (c, mark) => {
  const base = Number(c.realized) + Number(c.funding) - Number(c.fees);
  if (c.status === "CLOSED") return base;
  const q = Number(c.quantity);
  return base + (c.direction === "LONG" ? q * (Number(mark) - Number(c.average)) : q * (Number(c.average) - Number(mark)));
};

export default function Trades({ account: a }) {
  const [tab, setTab] = useState("open");
  const names = Object.fromEntries(a.bots.map((b) => [b.id, b.config.name]));
  const marks = Object.fromEntries(a.positions.map((p) => [p.id, p.mark]));
  const all = a.cycles.map((c) => ({ ...c, total: result(c, marks[c.id] ?? c.lastMark), mark: marks[c.id] ?? c.lastMark, label: entryLabel(c) }));
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
  const list = tab === "open" ? open : closed;

  return (
    <div className="trades">
      <section className="block">
        <header className="block-head"><h2>Результат по стратегиям входа</h2></header>
        {Object.keys(by).length === 0 ? <p className="empty-line">Сделок ещё не было.</p> : (
          <div className="table-wrap">
            <table className="grid-table compact">
              <thead><tr><th>Стратегия</th><th className="num">Сделок</th><th className="num">Открыто</th><th className="num">Закрыто в плюс</th><th className="num">Итог, USDT</th><th className="bar-col" aria-hidden="true" /></tr></thead>
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
        {list.length === 0 ? <p className="empty-line">{tab === "open" ? "Открытых сделок нет." : "Закрытых сделок пока нет."}</p> : (
          <div className="table-wrap">
            <table className="grid-table">
              <thead>
                <tr>
                  <th>Монета</th><th>Вход по</th><th>Бот</th><th className="num">Шаги</th><th className="num">Первый вход</th><th className="num">Средняя</th>
                  <th className="num">{tab === "open" ? "Цена сейчас" : "Причина"}</th><th className="num">По цене</th><th className="num">Фандинг</th><th className="num">Комиссии</th><th className="num">Итог</th>
                  <th>{tab === "open" ? "Открыта" : "Закрыта"}</th><th>Длилась</th>
                </tr>
              </thead>
              <tbody>
                {list.map((c) => {
                  const byPrice = c.total - Number(c.funding) + Number(c.fees);
                  return (
                    <tr key={c.id}>
                      <td><strong>{coin(c.symbol)}</strong> <span className={`side ${c.direction === "LONG" ? "long" : "short"}`}>{c.direction === "LONG" ? "Л" : "Ш"}</span></td>
                      <td><span className="chip">{c.label}</span></td>
                      <td className="muted">{names[c.botId] || "удалён"}</td>
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
    </div>
  );
}
