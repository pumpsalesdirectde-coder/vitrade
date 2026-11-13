import { useState } from "react";
import { post } from "../api.js";
import { money, signed, tone, when } from "../format.js";

const EXCHANGES = [
  { id: "bybit", name: "Bybit", status: "ready", note: "Цены, свечи и фандинг USDT-перпетуалов подключены. Следующий шаг — Demo-счёт по API-ключу." },
  { id: "okx", name: "OKX", status: "planned", note: "Публичные данные и Demo-режим — в плане работ." },
  { id: "binance", name: "Binance", status: "planned", note: "Публичные данные — в плане работ." },
  { id: "bitget", name: "Bitget", status: "planned", note: "Публичные данные — в плане работ." },
  { id: "bingx", name: "BingX", status: "planned", note: "Публичные данные — в плане работ." },
  { id: "hyperliquid", name: "Hyperliquid", status: "planned", note: "Публичные данные — в плане работ." },
];

function AccountRow({ a, refresh, onPick, setErr }) {
  const [edit, setEdit] = useState(false);
  const [name, setName] = useState(a.name);
  const act = async (path, data) => {
    try {
      await post(`/api/accounts/${a.id}/${path}`, data);
      setErr("");
      setEdit(false);
      refresh();
    } catch (e) {
      setErr(`${a.name}: ${e.message}`);
    }
  };
  return (
    <tr className={a.archived ? "archived" : ""}>
      <td>
        {edit ? (
          <form className="inline-form" onSubmit={(e) => { e.preventDefault(); act("rename", { name }); }}>
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={64} autoFocus aria-label="Название счёта" />
            <button className="primary">Сохранить</button>
            <button type="button" className="ghost" onClick={() => setEdit(false)}>Отмена</button>
          </form>
        ) : <><strong>{a.name}</strong>{a.archived && <span className="chip">в архиве</span>}<small className="sub muted">открыт {when(a.createdAt)}</small></>}
      </td>
      <td><span className="chip paper-chip">Paper</span></td>
      <td className="num">{money(a.equity)}</td>
      <td className={`num ${tone(a.net)}`}>{signed(a.net)}</td>
      <td className="num">{a.bots.length}</td>
      <td className="num">{a.positions.length}</td>
      <td>
        <div className="row-actions">
          {!a.archived && <a className="btn ghost" href="#/overview" onClick={() => onPick(a.id)}>Открыть</a>}
          {!edit && <button className="ghost" onClick={() => setEdit(true)}>Переименовать</button>}
          {a.archived
            ? <button onClick={() => act("restore")}>Вернуть из архива</button>
            : <button className="ghost danger-text" onClick={() => confirm(`Отправить счёт «${a.name}» в архив? Боты остановятся, история сохранится.`) && act("archive")}>В архив</button>}
        </div>
      </td>
    </tr>
  );
}

export default function Exchanges({ state, refresh, onPick }) {
  const [form, setForm] = useState({ name: "", initial: "10000" });
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState("");
  const active = state.accounts.filter((a) => !a.archived);
  const create = async (e) => {
    e.preventDefault();
    try {
      const { id } = await post("/api/accounts", { ...form, exchange: "bybit" });
      setOpen(false);
      setForm({ name: "", initial: "10000" });
      onPick(id);
      refresh();
    } catch (x) {
      setErr(x.message);
    }
  };

  return (
    <div className="exchanges">
      <div className="tiles three">
        <div className="tile"><span>Всего счетов</span><b>{state.accounts.length}</b><small>в архиве {state.accounts.length - active.length}</small></div>
        <div className="tile"><span>Paper</span><b>{active.length} <small>из {state.limits.accounts}</small></b><small>виртуальный капитал, реальные цены</small></div>
        <div className="tile"><span>Demo</span><b>0</b><small>подключение по API — следующий этап</small></div>
      </div>

      {EXCHANGES.map((x) => (
        <section key={x.id} className={`panel exchange ${x.status}`}>
          <header className="panel-head">
            <div className="ex-name">
              <b className="ex-logo">{x.name}</b>
              <span className={`state ${x.status === "ready" ? "live" : "off"}`}>{x.status === "ready" ? "Данные подключены" : "Скоро"}</span>
            </div>
            {x.status === "ready" && !open && <button className="primary" onClick={() => setOpen(true)}>Открыть paper-счёт</button>}
          </header>
          <p className="muted small">{x.note}</p>
          {x.status === "ready" && (
            <>
              {open && (
                <form className="create-account" onSubmit={create}>
                  <label>Название<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required maxLength={64} placeholder="Например: Шорт стадии x3" autoFocus /></label>
                  <label>Стартовый капитал, USDT<input className="num" inputMode="decimal" value={form.initial} onChange={(e) => setForm({ ...form, initial: e.target.value })} /></label>
                  <button className="primary">Открыть счёт</button>
                  <button type="button" className="ghost" onClick={() => setOpen(false)}>Отмена</button>
                </form>
              )}
              {err && <div className="banner">{err}</div>}
              <div className="table-wrap">
                <table className="grid-table">
                  <thead><tr><th>Счёт</th><th>Режим</th><th className="num">Капитал</th><th className="num">С начала</th><th className="num">Ботов</th><th className="num">Позиций</th><th /></tr></thead>
                  <tbody>{state.accounts.map((a) => <AccountRow key={a.id} a={a} refresh={refresh} onPick={onPick} setErr={setErr} />)}</tbody>
                </table>
              </div>
            </>
          )}
        </section>
      ))}
    </div>
  );
}
