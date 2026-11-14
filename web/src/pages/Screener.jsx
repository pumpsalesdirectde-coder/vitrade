import { useMemo, useState } from "react";
import { usePoll } from "../api.js";
import Hint from "../ui/Hint.jsx";
import { STRATEGY, coin, money, pct, price, signed, tone, when } from "../format.js";

const STAGES = ["PUMP", "EARLY", "FLIP", "DUMP", "CRASH"];

export default function Screener({ state }) {
  const { data } = usePoll("/api/market", 15000);
  const [view, setView] = useState("stages");
  const [q, setQ] = useState("");
  const held = useMemo(() => {
    const m = {};
    for (const a of state.accounts) for (const p of a.positions) (m[p.symbol] ||= []).push(a.name);
    return m;
  }, [state]);
  const quotes = data?.quotes || [];
  const counts = Object.fromEntries(STAGES.map((s) => [s, quotes.filter((x) => x.stage === s).length]));
  const rows = quotes
    .filter((x) => (view === "stages" ? !!x.stage : view === "rsi" ? x.eligible : view === "movers" ? Math.abs(Number(x.change)) >= 10 : STAGES.includes(view) ? x.stage === view : true))
    .filter((x) => !q || x.symbol.includes(q.toUpperCase()));

  return (
    <div className="screener">
      <section className="panel">
        <div className="stage-strip">
          {STAGES.map((s) => (
            <button key={s} className={`stage-card ${view === s ? "on" : ""}`} onClick={() => setView(view === s ? "stages" : s)}>
              <span>{STRATEGY[s].name}</span>
              <b>{counts[s]}</b>
              <small>{STRATEGY[s].about}</small>
            </button>
          ))}
        </div>
      </section>

      <section className="panel">
        <header className="panel-head">
          <div className="seg" role="group" aria-label="Выборка">
            {[["stages", "Со стадией"], ["movers", "Движение 10%+"], ["rsi", "Топ-50 для RSI"], ["all", "Все"]].map(([k, l]) => (
              <button key={k} aria-pressed={view === k} onClick={() => setView(k)}>{l}</button>
            ))}
          </div>
          <input className="search" placeholder="Монета" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Поиск монеты" />
        </header>
        <p className="muted small">Стадия пересчитывается раз в час по закрытым часовым свечам, RSI — каждые 5 минут. Обновлено {when(data?.health?.at)}.</p>
        {rows.length === 0 ? <p className="empty-line">{data ? "Под этот фильтр сейчас монет нет." : "Загрузка рынка…"}</p> : (
          <div className="table-wrap">
            <table className="grid-table">
              <thead>
                <tr><th>Монета</th><th className="num">Цена</th><th className="num">24 ч</th><th className="num"><Hint term="turnover">Оборот 24 ч</Hint></th><th><Hint term="stage">Стадия</Hint></th><th className="num">Памп</th><th className="num">От вершины</th><th className="num"><Hint term="rsi">RSI 14</Hint></th><th className="num"><Hint term="funding">Фандинг</Hint></th><th>На счетах</th></tr>
              </thead>
              <tbody>
                {rows.slice(0, 300).map((x) => (
                  <tr key={x.symbol}>
                    <td><strong>{coin(x.symbol)}</strong></td>
                    <td className="num">{price(x.mark)}</td>
                    <td className={`num ${tone(x.change)}`}>{signed(x.change, 1, "%")}</td>
                    <td className="num">{money(Number(x.turnover) / 1e6, 1, "")} млн $</td>
                    <td>{x.stage ? <span className={`chip stage-${x.stage}`}>{STRATEGY[x.stage].name}</span> : <span className="muted">—</span>}</td>
                    <td className="num">{x.stagePump !== undefined && x.stage ? pct(x.stagePump * 100, 0) : "—"}</td>
                    <td className="num">{x.stageDrop !== undefined && x.stage ? pct(x.stageDrop * 100, 1) : "—"}</td>
                    <td className="num">{x.rsi !== undefined && x.eligible ? <span className={x.rsi >= 70 ? "down" : x.rsi <= 30 ? "up" : ""}>{x.rsi.toFixed(0)}</span> : "—"}</td>
                    <td className={`num ${tone(-x.fundingRate)}`}>{x.fundingRate !== undefined ? signed(Number(x.fundingRate) * 100, 4, "%") : "—"}</td>
                    <td className="muted">{held[x.symbol]?.join(", ") || ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
