import { useState } from "react";
import { post } from "../api.js";
import { STRATEGY, STRATEGY_ORDER, botStatus, coin, money, signed, tone } from "../format.js";
import Hint from "../ui/Hint.jsx";
import { activeFork } from "../fork-state.js";

function strategies(cfg) {
  if (cfg.mode === "manual") return `Вручную · ${coin(cfg.symbol)} ${cfg.direction === "LONG" ? "лонг" : "шорт"}`;
  return STRATEGY_ORDER.filter((k) => cfg.stages?.[k]).map((k) => STRATEGY[k].short).join(", ");
}

function Actions({ a, b, c, refresh, setErr }) {
  const pair = activeFork(a.forks, b.id);
  const run = async (action, payload, confirmText) => {
    if (confirmText && !confirm(confirmText)) return;
    try {
      await post(`/api/accounts/${a.id}/bots/${b.id}/commands`, { action, payload });
      setErr("");
      refresh();
    } catch (e) {
      setErr(`${b.config.name}: ${e.message}`);
    }
  };
  const remove = async () => {
    if (!confirm(`Удалить бота «${b.config.name}»? История его сделок останется в «Сделках».`)) return;
    try {
      await post(`/api/accounts/${a.id}/bots/${b.id}/delete`);
      refresh();
    } catch (e) {
      setErr(e.message);
    }
  };
  const buttons = [];
  if (pair) return <div className="row-actions"><a className="btn" href={`#/fork/${pair.parentBotId}`}>К паре</a><button className="danger" disabled={pair.status === "CLOSING"} onClick={() => run("close", {}, `Закрыть обе позиции ${coin(pair.symbol)} по рынку и остановить обоих ботов?`)}>{pair.status === "CLOSING" ? "Пара закрывается" : "Закрыть обе позиции"}</button></div>;
  if (b.forkParentId) return <div className="row-actions"><a className="btn ghost" href={`#/fork/${b.forkParentId}`}>История вилки</a></div>;
  if (!b.enabled && !c) {
    buttons.push(<button key="s" className="primary" onClick={() => run("start")}>Запустить</button>);
    buttons.push(<a key="e" className="btn" href={`#/edit/${b.id}`}>Настроить</a>);
    buttons.push(<button key="d" className="ghost danger-text" onClick={remove}>Удалить</button>);
  } else {
    if (c && !b.paused) buttons.push(<button key="p" onClick={() => run("pause")} title="Новые шаги сетки не исполняются; тейк, стоп и подушка продолжают работать">Пауза докупок</button>);
    if (b.paused) buttons.push(<button key="r" onClick={() => run("resume")}>Возобновить докупки</button>);
    if (!b.finish) buttons.push(<button key="f" onClick={() => run("finish")} title={c ? "Бот доведёт текущую сделку по стратегии и остановится" : "Остановить бота"}>{c ? "Довести и стоп" : "Остановить"}</button>);
    if (c) buttons.push(<button key="x" className="danger" onClick={() => run("close", {}, `Закрыть позицию ${coin(c.symbol)} по рынку и остановить бота?`)}>Закрыть по рынку</button>);
    buttons.push(<a key="e" className="btn ghost" href={`#/edit/${b.id}`}>Настройки</a>);
  }
  return <div className="row-actions">{buttons}</div>;
}

export default function Bots({ account: a, refresh }) {
  const [err, setErr] = useState("");
  const [filter, setFilter] = useState("all");
  const rows = a.bots.map((b) => {
    const c = a.positions.find((p) => p.id === b.currentCycleId);
    const done = a.cycles.filter((x) => x.botId === b.id && x.status === "CLOSED");
    const result = done.reduce((s, x) => s + Number(x.realized) + Number(x.funding) - Number(x.fees), 0);
    const pair = activeFork(a.forks, b.id);
    return { b, c, done, result, pair, st: botStatus(b, c) };
  });
  const shown = rows.filter((r) => filter === "all" || (filter === "pos" ? r.c : filter === "wait" ? !r.c && r.b.enabled : !r.b.enabled && !r.c));
  const counts = { all: rows.length, pos: rows.filter((r) => r.c).length, wait: rows.filter((r) => !r.c && r.b.enabled).length, off: rows.filter((r) => !r.b.enabled && !r.c).length };

  return (
    <section className="block">
      <header className="block-head with-action">
        <div>
          <h2>Боты счёта «{a.name}» <span className="count">{a.bots.length}</span></h2>
          <div className="seg" role="group" aria-label="Фильтр">
            {[["all", "Все"], ["pos", "В позиции"], ["wait", "Ждут"], ["off", "Остановлены"]].map(([k, l]) => (
              <button key={k} aria-pressed={filter === k} onClick={() => setFilter(k)}>{l} {counts[k]}</button>
            ))}
          </div>
        </div>
        <a className="btn primary" href="#/new">Новый бот</a>
      </header>
      {err && <div className="banner">{err}</div>}
      {shown.length === 0 ? <p className="empty-line">{a.bots.length ? "В этой группе ботов нет." : "Ботов пока нет — создайте первого кнопкой «Новый бот»."}</p> : (
        <div className="table-wrap">
          <table className="grid-table">
            <thead>
              <tr><th>Бот</th><th>Стратегии входа</th><th>Состояние</th><th>Позиция</th><th className="num"><Hint term="budget">Бюджет</Hint> × <Hint term="leverage">плечо</Hint></th><th className="num">Закрыто</th><th className="num"><Hint term="realized">Итог закрытых</Hint></th><th className="num"><Hint term="unrealized">Плавающий</Hint></th><th /></tr>
            </thead>
            <tbody>
              {shown.map(({ b, c, done, result, st, pair }) => (
                <tr key={b.id}>
                  <td><strong>{b.config.name}</strong>{b.forkParentId ? <a className="sub small fork-link" href={`#/fork/${b.forkParentId}`}>Лонг вилки ↔ {a.bots.find((parent) => parent.id === b.forkParentId)?.config.name || "основной шорт"}</a> : <a className="sub small fork-link" href={`#/fork/${b.id}`}>{pair ? "Шорт вилки ↔ связанный лонг" : `Вилка: ${b.config.fork?.enabled === false ? "выключена" : "включена"}`}</a>}</td>
                  <td className="muted wrap">{b.forkParentId ? "Связанный лонг · общий выход" : strategies(b.config)}</td>
                  <td><span className={`state ${st.key}`}>{st.text}</span>{!c && b.enabled && <small className="sub muted">{b.lastReason}</small>}</td>
                  <td>{c ? <><strong>{coin(c.symbol)}</strong> <span className={`side ${c.direction === "LONG" ? "long" : "short"}`}>{c.direction === "LONG" ? "Лонг" : "Шорт"}</span> <small className="muted">{pair ? "объём зафиксирован" : `шаг ${c.usedSteps}/${c.config.steps}`}</small></> : <span className="muted">—</span>}</td>
                  <td className="num">{money(b.config.budget, 0)} × {b.config.leverage}</td>
                  <td className="num">{done.length}</td>
                  <td className={`num ${tone(result)}`}>{done.length ? signed(result) : "—"}</td>
                  <td className={`num ${c ? tone(c.net) : ""}`}>{c ? signed(c.net) : "—"}</td>
                  <td><Actions a={a} b={b} c={c} refresh={refresh} setErr={setErr} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
