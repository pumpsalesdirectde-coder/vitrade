import { useState } from "react";
import { coin, money, signed, tone } from "../format.js";
import Hint from "../ui/Hint.jsx";
import TradeChart from "../ui/TradeChart.jsx";
import { exchangeName, runningBots } from "../ui/AccountSwitch.jsx";

const NEED = { bots: "ботов", trades: "сделки", stats: "статистику" };

/** Общая сводка по всем счетам пользователя. */
export default function AllAccounts({ accounts, page, onPick }) {
  const [chart, setChart] = useState(null);
  const sum = (k) => accounts.reduce((s, a) => s + Number(a[k] || 0), 0);
  const initial = sum("initial");
  const net = sum("net");
  const bots = accounts.reduce((s, a) => s + a.bots.filter((b) => !b.forkParentId).length, 0);
  const running = accounts.reduce((s, a) => s + runningBots(a), 0);
  const positions = accounts.flatMap((a) => a.positions.map((p) => ({ ...p, account: a })));
  const names = (a) => Object.fromEntries(a.bots.map((b) => [b.id, b.config.name]));

  return (
    <div className="all-accounts">
      {NEED[page] && <div className="notice">Чтобы открыть {NEED[page]}, выберите счёт в строке ниже или в переключателе «Все счета» сверху.</div>}

      <div className="tiles">
        <div className="tile"><span><Hint term="equity">Капитал всех счетов</Hint></span><b>{money(sum("equity"))}</b><small>старт {money(initial, 0)}</small></div>
        <div className="tile"><span><Hint term="pnl">PnL</Hint></span><b className={tone(net)}>{signed(net)}</b><small className={tone(net)}>{initial ? signed((net / initial) * 100, 2, "%") : "—"} от старта</small></div>
        <div className="tile"><span><Hint term="unrealized">Плавающий</Hint></span><b className={tone(sum("unrealized"))}>{signed(sum("unrealized"))}</b><small>по {positions.length} открытым позициям</small></div>
        <div className="tile"><span>Боты</span><b>{running} <small>из {bots}</small></b><small>работают на {accounts.length} счетах</small></div>
      </div>

      <section className="block">
        <header className="block-head"><h2>Счета <span className="count">{accounts.length}</span></h2></header>
        <div className="table-wrap">
          <table className="grid-table">
            <thead><tr><th>Счёт</th><th>Биржа</th><th className="num"><Hint term="equity">Капитал</Hint></th><th className="num"><Hint term="pnl">PnL</Hint></th><th className="num">PnL, %</th><th className="num"><Hint term="unrealized">Плавающий</Hint></th><th className="num">Ботов работает</th><th className="num">Позиций</th></tr></thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.id} className="clickable" onClick={(e) => !e.target.closest("button") && onPick(a.id)}>
                  <td><button className="coin-link" onClick={() => onPick(a.id)} title="Перейти к счёту"><strong>{a.name}</strong></button> <span className="chip paper-chip">Paper</span></td>
                  <td>{exchangeName(a)}</td>
                  <td className="num">{money(a.equity)}</td>
                  <td className={`num ${tone(a.net)}`}><b>{signed(a.net)}</b></td>
                  <td className={`num ${tone(a.net)}`}>{signed((Number(a.net) / Number(a.initial)) * 100, 2, "%")}</td>
                  <td className={`num ${tone(a.unrealized)}`}>{signed(a.unrealized)}</td>
                  <td className="num">{runningBots(a)} / {a.bots.filter((b) => !b.forkParentId).length}</td>
                  <td className="num">{a.positions.length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="block">
        <header className="block-head"><h2>Открытые позиции <span className="count">{positions.length}</span></h2></header>
        {positions.length === 0 ? <p className="empty-line">Открытых позиций нет ни на одном счёте.</p> : (
          <div className="table-wrap">
            <table className="grid-table">
              <thead><tr><th>Монета</th><th>Счёт</th><th>Бот</th><th className="num">Шаг</th><th className="num"><Hint term="margin">Маржа</Hint></th><th className="num"><Hint term="unrealized">Плавающий</Hint></th></tr></thead>
              <tbody>
                {positions.sort((x, y) => Number(x.net) - Number(y.net)).map((p) => (
                  <tr key={p.id}>
                    <td><button className="coin-link" onClick={() => setChart(p)} title="Открыть график сделки"><strong>{coin(p.symbol)}</strong></button> <span className={`side ${p.direction === "LONG" ? "long" : "short"}`}>{p.direction === "LONG" ? "Лонг" : "Шорт"}</span></td>
                    <td><button className="coin-link" onClick={() => onPick(p.account.id)} title="Перейти к счёту">{p.account.name}</button></td>
                    <td className="muted">{names(p.account)[p.botId] || "—"}</td>
                    <td className="num">{p.usedSteps}/{p.config.steps}</td>
                    <td className="num">{money(p.margin)}</td>
                    <td className={`num ${tone(p.net)}`}><b>{signed(p.net)}</b></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {chart && <TradeChart account={chart.account} cycle={chart} position={chart} onClose={() => setChart(null)} />}
    </div>
  );
}
