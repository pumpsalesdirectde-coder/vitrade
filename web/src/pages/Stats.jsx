import { useMemo, useState } from "react";
import { CLOSE_REASON, coin, duration, entryLabel, money, pct, price, signed, tone, when } from "../format.js";
import Hint from "../ui/Hint.jsx";
import TradeChart from "../ui/TradeChart.jsx";

const DAY = 864e5;
const startOfDay = (t) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
const PERIODS = [
  ["today", "Сегодня"], ["yesterday", "Вчера"], ["7", "7 дней"], ["30", "30 дней"], ["all", "Всё время"],
];
function range(period) {
  const today = startOfDay(Date.now());
  if (period === "today") return [today, Infinity];
  if (period === "yesterday") return [today - DAY, today];
  if (period === "7" || period === "30") return [today - (Number(period) - 1) * DAY, Infinity];
  return [0, Infinity];
}
const net = (c) => Number(c.realized) + Number(c.funding) - Number(c.fees);

function group(list, key) {
  const m = {};
  for (const c of list) {
    const k = key(c);
    m[k] ||= { n: 0, win: 0, total: 0, time: 0 };
    m[k].n++;
    if (c.net > 0) m[k].win++;
    m[k].total += c.net;
    m[k].time += c.closedAt - c.openedAt;
  }
  return Object.entries(m).sort((a, b) => b[1].total - a[1].total);
}

function Breakdown({ title, rows, label = (k) => k }) {
  const max = Math.max(...rows.map(([, v]) => Math.abs(v.total)), 1e-9);
  return (
    <section className="panel">
      <h3 className="panel-title">{title}</h3>
      {rows.length === 0 ? <p className="muted">Нет закрытых сделок</p> : (
        <table className="grid-table compact">
          <tbody>
            {rows.slice(0, 12).map(([k, v]) => (
              <tr key={k}>
                <td><strong>{label(k)}</strong> <small className="muted">{v.n} сд. · в плюс {v.win}</small></td>
                <td className="bar-col"><span className={`hbar ${tone(v.total)}`} style={{ width: `${(Math.abs(v.total) / max) * 100}%` }} /></td>
                <td className={`num ${tone(v.total)}`}><b>{signed(v.total)}</b></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function Curve({ list }) {
  if (list.length < 2) return <div className="curve empty muted">Кривая появится после двух закрытых сделок</div>;
  const pts = [];
  let s = 0;
  for (const c of [...list].sort((a, b) => a.closedAt - b.closedAt)) {
    s += c.net;
    pts.push([c.closedAt, s]);
  }
  const t0 = pts[0][0];
  const t1 = pts.at(-1)[0];
  const vals = [0, ...pts.map((p) => p[1])];
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const pad = (hi - lo) * 0.1 || 1;
  const W = 600;
  const H = 140;
  const X = (t) => ((t - t0) / (t1 - t0 || 1)) * W;
  const Y = (v) => H - ((v - lo + pad) / (hi - lo + 2 * pad)) * H;
  const d = pts.map(([t, v], i) => `${i ? "L" : "M"}${X(t).toFixed(1)} ${Y(v).toFixed(1)}`).join(" ");
  return (
    <svg className="curve" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`Накопленный результат ${signed(s)}`}>
      <line className="eq-base" x1="0" x2={W} y1={Y(0)} y2={Y(0)} />
      <path className={`eq-line ${s >= 0 ? "up" : "down"}`} d={d} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function toCsv(list, names) {
  const head = ["Закрыта", "Открыта", "Монета", "Сторона", "Вход по", "Бот", "Шаги", "Первый вход", "Средняя", "Причина", "По цене", "Фандинг", "Комиссии", "Итог", "Бюджет", "Плечо"];
  const rows = list.map((c) => [
    new Date(c.closedAt).toISOString(), new Date(c.openedAt).toISOString(), c.symbol, c.direction, c.label, names[c.botId] || "",
    `${c.usedSteps}/${c.config.steps}`, c.anchor, c.average, CLOSE_REASON[c.closeReason] || c.closeReason,
    c.realized, c.funding, c.fees, c.net.toFixed(6), c.config.budget, c.config.leverage,
  ]);
  return [head, ...rows].map((r) => r.map((v) => `"${String(v).replaceAll('"', '""')}"`).join(";")).join("\r\n");
}

export default function Stats({ account: a }) {
  const [period, setPeriod] = useState("all");
  const [tab, setTab] = useState("analytics");
  const [chart, setChart] = useState(null);
  const [filter, setFilter] = useState({ q: "", dir: "", reason: "", label: "" });
  const names = Object.fromEntries(a.bots.map((b) => [b.id, b.config.name]));
  const [from, to] = range(period);
  const closed = useMemo(() => a.cycles.filter((c) => c.status === "CLOSED" && c.closedAt >= from && c.closedAt < to)
    .map((c) => ({ ...c, net: net(c), label: entryLabel(c) })).sort((x, y) => y.closedAt - x.closedAt), [a, from, to]);

  const total = closed.reduce((s, c) => s + c.net, 0);
  const wins = closed.filter((c) => c.net > 0);
  const losses = closed.filter((c) => c.net <= 0);
  const avg = (l, f) => (l.length ? l.reduce((s, c) => s + f(c), 0) / l.length : 0);
  const budget = a.bots.reduce((s, b) => s + Number(b.config.budget), 0) || 1;
  const costs = closed.reduce((s, c) => s + Number(c.funding) - Number(c.fees), 0);
  const best = closed.reduce((m, c) => (!m || c.net > m.net ? c : m), null);
  const worst = closed.reduce((m, c) => (!m || c.net < m.net ? c : m), null);
  const longest = closed.reduce((m, c) => (!m || c.closedAt - c.openedAt > m.closedAt - m.openedAt ? c : m), null);

  const journal = closed.filter((c) => (!filter.q || c.symbol.includes(filter.q.toUpperCase()))
    && (!filter.dir || c.direction === filter.dir) && (!filter.reason || c.closeReason === filter.reason) && (!filter.label || c.label === filter.label));

  const download = () => {
    const blob = new Blob(["﻿" + toCsv(journal, names)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = Object.assign(document.createElement("a"), { href: url, download: `vitrade-${a.name}-${new Date().toISOString().slice(0, 10)}.csv` });
    link.click();
    URL.revokeObjectURL(url);
  };

  // календарь: боты × дни (до 31 последнего дня периода)
  const lastDay = startOfDay(Math.min(Date.now(), to === Infinity ? Date.now() : to - 1));
  const firstDay = Math.max(startOfDay(from || lastDay - 29 * DAY), lastDay - 30 * DAY);
  const days = [];
  for (let t = firstDay; t <= lastDay; t += DAY) days.push(t);
  const cal = {};
  for (const c of closed) {
    const k = startOfDay(c.closedAt);
    ((cal[c.botId] ||= {})[k] ||= 0);
    cal[c.botId][k] += c.net;
  }

  return (
    <div className="stats">
      <div className="toolbar">
        <div className="seg" role="tablist" aria-label="Вид">
          {[["analytics", "Аналитика"], ["journal", "Журнал"], ["calendar", "Календарь"]].map(([k, l]) => (
            <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{l}</button>
          ))}
        </div>
        <div className="seg" role="group" aria-label="Период">
          {PERIODS.map(([k, l]) => <button key={k} aria-pressed={period === k} onClick={() => setPeriod(k)}>{l}</button>)}
        </div>
      </div>

      {tab === "analytics" && (
        <>
          <section className="panel result-panel">
            <div>
              <span className="muted">Результат закрытых сделок</span>
              <strong className={`big ${tone(total)}`}>{signed(total)}</strong>
              <span className="muted">{signed((total / budget) * 100, 2, "%")} к сумме бюджетов ботов ({money(budget, 0)})</span>
            </div>
            <Curve list={closed} />
          </section>
          <div className="tiles">
            <div className="tile"><span>Сделок закрыто</span><b>{closed.length}</b><small>в плюс {wins.length} · в минус {losses.length}</small></div>
            <div className="tile"><span>Доля прибыльных</span><b>{closed.length ? pct((wins.length / closed.length) * 100, 0) : "—"}</b><small>за выбранный период</small></div>
            <div className="tile"><span><Hint term="total">Средняя сделка</Hint></span><b className={tone(avg(closed, (c) => c.net))}>{closed.length ? signed(avg(closed, (c) => c.net)) : "—"}</b><small>плюс {signed(avg(wins, (c) => c.net))} · минус {signed(avg(losses, (c) => c.net))}</small></div>
            <div className="tile"><span>Среднее время</span><b>{closed.length ? duration(0, avg(closed, (c) => c.closedAt - c.openedAt)) : "—"}</b><small>от входа до выхода</small></div>
            <div className="tile"><span><Hint term="funding">Фандинг и комиссии</Hint></span><b className={tone(costs)}>{signed(costs)}</b><small>уже учтены в результате</small></div>
          </div>
          <div className="two-col">
            <Breakdown title="По ботам" rows={group(closed, (c) => names[c.botId] || "удалённый бот")} />
            <Breakdown title="По стратегиям входа" rows={group(closed, (c) => c.label)} />
            <Breakdown title="По монетам" rows={group(closed, (c) => c.symbol)} label={coin} />
            <Breakdown title="Лонг и шорт" rows={group(closed, (c) => c.direction)} label={(k) => (k === "LONG" ? "Лонг" : "Шорт")} />
          </div>
          {best && (
            <section className="panel">
              <h3 className="panel-title">Рекорды периода</h3>
              <dl className="records">
                <div><dt>Лучшая сделка</dt><dd className="up">{signed(best.net)}</dd><small className="muted">{coin(best.symbol)} · {best.label} · {when(best.closedAt)}</small></div>
                <div><dt>Худшая сделка</dt><dd className={tone(worst.net)}>{signed(worst.net)}</dd><small className="muted">{coin(worst.symbol)} · {worst.label} · {when(worst.closedAt)}</small></div>
                <div><dt>Самая долгая</dt><dd>{duration(longest.openedAt, longest.closedAt)}</dd><small className="muted">{coin(longest.symbol)} · {signed(longest.net)}</small></div>
              </dl>
            </section>
          )}
        </>
      )}

      {tab === "journal" && (
        <section className="panel">
          <header className="panel-head">
            <div className="filters">
              <input placeholder="Монета" value={filter.q} onChange={(e) => setFilter({ ...filter, q: e.target.value })} aria-label="Монета" />
              <select value={filter.dir} onChange={(e) => setFilter({ ...filter, dir: e.target.value })} aria-label="Сторона"><option value="">Обе стороны</option><option value="SHORT">Шорт</option><option value="LONG">Лонг</option></select>
              <select value={filter.reason} onChange={(e) => setFilter({ ...filter, reason: e.target.value })} aria-label="Причина"><option value="">Все причины</option>{Object.entries(CLOSE_REASON).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
              <select value={filter.label} onChange={(e) => setFilter({ ...filter, label: e.target.value })} aria-label="Стратегия"><option value="">Все стратегии</option>{[...new Set(closed.map((c) => c.label))].map((l) => <option key={l}>{l}</option>)}</select>
            </div>
            <button onClick={download} disabled={!journal.length}>Скачать CSV</button>
          </header>
          {journal.length === 0 ? <p className="empty-line">Закрытых сделок под эти условия нет.</p> : (
            <div className="table-wrap">
              <table className="grid-table">
                <thead><tr><th>Закрыта</th><th>Монета</th><th>Вход по</th><th>Бот</th><th className="num">Шаги</th><th className="num"><Hint term="anchor">Первый вход</Hint></th><th className="num"><Hint term="average">Средняя</Hint></th><th>Причина</th><th className="num"><Hint term="funding">Фандинг</Hint></th><th className="num"><Hint term="total">Итог</Hint></th><th className="num">% бюджета</th><th>Длилась</th></tr></thead>
                <tbody>
                  {journal.map((c) => (
                    <tr key={c.id}>
                      <td>{when(c.closedAt)}</td>
                      <td><button className="coin-link" onClick={() => setChart(c)} title="Открыть график сделки"><strong>{coin(c.symbol)}</strong></button> <span className={`side ${c.direction === "LONG" ? "long" : "short"}`}>{c.direction === "LONG" ? "Л" : "Ш"}</span></td>
                      <td><span className="chip">{c.label}</span></td>
                      <td className="muted">{names[c.botId] || "удалён"}</td>
                      <td className="num">{c.usedSteps}/{c.config.steps}</td>
                      <td className="num">{price(c.anchor)}</td>
                      <td className="num">{price(c.average)}</td>
                      <td>{CLOSE_REASON[c.closeReason] || c.closeReason}</td>
                      <td className={`num ${tone(c.funding)}`}>{signed(c.funding, 3)}</td>
                      <td className={`num ${tone(c.net)}`}><b>{signed(c.net)}</b></td>
                      <td className={`num ${tone(c.net)}`}>{signed((c.net / Number(c.config.budget)) * 100, 2, "%")}</td>
                      <td>{duration(c.openedAt, c.closedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {tab === "calendar" && (
        <section className="panel">
          <p className="muted small">Итог закрытых сделок по дням закрытия. Показано до 31 последнего дня выбранного периода.</p>
          <div className="table-wrap">
            <table className="grid-table calendar">
              <thead>
                <tr><th>Бот</th>{days.map((d) => <th key={d} className="num">{new Date(d).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" })}</th>)}<th className="num"><Hint term="total">Итог</Hint></th></tr>
              </thead>
              <tbody>
                {a.bots.map((b) => {
                  const row = cal[b.id] || {};
                  const sum = days.reduce((s, d) => s + (row[d] || 0), 0);
                  return (
                    <tr key={b.id}>
                      <td><strong>{b.config.name}</strong></td>
                      {days.map((d) => <td key={d} className={`num cell ${row[d] ? tone(row[d]) : "zero"}`}>{row[d] ? signed(row[d], 1, "") : "·"}</td>)}
                      <td className={`num ${tone(sum)}`}><b>{sum ? signed(sum) : "—"}</b></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {chart && <TradeChart account={a} cycle={chart} onClose={() => setChart(null)} />}
    </div>
  );
}
