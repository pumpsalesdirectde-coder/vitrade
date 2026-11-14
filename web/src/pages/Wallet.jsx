import { useState } from "react";
import { post, usePoll } from "../api.js";
import { money, signed, tone, when } from "../format.js";
import Hint from "../ui/Hint.jsx";

const TYPE = { WELCOME: "Бонус", DEPOSIT: "Пополнение", FEE: "Комиссия", REF: "Реферальные" };
const FILTERS = [["all", "Все"], ["FEE", "Комиссии"], ["DEPOSIT", "Пополнения"], ["REF", "Реферальные"]];

export default function Wallet({ refresh }) {
  const { data, reload } = usePoll("/api/wallet", 15000);
  const [amount, setAmount] = useState("100");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [filter, setFilter] = useState("all");

  const topUp = async (e) => {
    e.preventDefault();
    setBusy(true);
    setErr("");
    setMsg("");
    try {
      await post("/api/wallet/deposit", { amount: Number(String(amount).replace(",", ".")) });
      setMsg(`Баланс пополнен на ${money(amount)} (виртуально)`);
      reload?.();
      refresh();
    } catch (x) {
      setErr(x.message);
    } finally {
      setBusy(false);
    }
  };

  if (!data) return <p className="muted">Загрузка…</p>;
  const pct = Math.round(data.feeRate * 100);
  const rows = data.tx.filter((t) => filter === "all" || t.type === filter || (filter === "DEPOSIT" && t.type === "WELCOME"));

  return (
    <div className="wallet">
      <div className="notice">
        <b>Тестовый режим.</b> Пока боты торгуют на виртуальных счетах, кошелёк тоже виртуальный: пополнение без реальных денег,
        комиссия списывается с виртуальной прибыли. Так можно проверить, как будет работать оплата, до подключения реальной торговли.
      </div>

      <section className={`panel wallet-hero ${data.balance < 0 ? "minus" : ""}`}>
        <div>
          <span className="muted"><Hint text="Деньги на счёте площадки. С них списывается комиссия за прибыльные сделки. При отрицательном балансе боты не открывают новые сделки, открытые продолжают работать.">Баланс кошелька</Hint></span>
          <strong className={`big ${data.balance < 0 ? "down" : ""}`}>{money(data.balance)}</strong>
          <span className="muted">{data.balance < 0 ? "Баланс в минусе — новые сделки ботов остановлены" : "Боты работают, комиссия спишется с этого баланса"}</span>
        </div>
        <form className="topup" onSubmit={topUp}>
          <label>Пополнить, $<input className="num" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
          <div className="quick">
            {[50, 100, 500].map((v) => <button type="button" key={v} className="ghost" onClick={() => setAmount(String(v))}>{v} $</button>)}
          </div>
          <button className="primary" disabled={busy}>Пополнить</button>
          {msg && <small className="up">{msg}</small>}
          {err && <small className="down">{err}</small>}
        </form>
      </section>

      <div className="tiles">
        <div className="tile"><span>Пополнено</span><b>{money(data.totals.deposits)}</b><small>с приветственным бонусом</small></div>
        <div className="tile"><span><Hint text={`${pct}% от чистой прибыли каждой прибыльной закрытой сделки: прибыль по цене + фандинг − комиссии биржи. С убыточных сделок комиссия не берётся.`}>Комиссия площадки</Hint></span><b>{money(data.totals.fees)}</b><small>{pct}% с прибыльных сделок</small></div>
        <div className="tile"><span>Реферальный доход</span><b className="up">{money(data.totals.referral)}</b><small><a href="#/referrals">программа приглашений</a></small></div>
      </div>

      <section className="panel">
        <h3 className="panel-title">Как работает оплата</h3>
        <ol className="steps-list">
          <li><b>Пополните баланс</b> в долларах (USDT).</li>
          <li><b>Боты торгуют.</b> Пока сделка в минусе или в нуле, вы ничего не платите.</li>
          <li><b>С каждой прибыльной сделки</b> списывается {pct}% её чистой прибыли. Пример: сделка принесла 50 $ — комиссия {money(50 * data.feeRate)}.</li>
          <li><b>Если баланс ушёл в минус,</b> боты не открывают новые сделки, пока вы его не пополните. Открытые позиции доводятся как обычно.</li>
        </ol>
        <p className="muted small">Ключи API с правом вывода средств площадка не запрашивает: деньги на бирже остаются под вашим контролем.</p>
      </section>

      <section className="block">
        <header className="block-head with-action">
          <h2>История операций</h2>
          <div className="seg" role="group" aria-label="Тип операций">
            {FILTERS.map(([k, l]) => <button key={k} aria-pressed={filter === k} onClick={() => setFilter(k)}>{l}</button>)}
          </div>
        </header>
        {rows.length === 0 ? <p className="empty-line">Операций пока нет.</p> : (
          <div className="table-wrap">
            <table className="grid-table">
              <thead><tr><th>Дата</th><th>Операция</th><th>Описание</th><th className="num">Прибыль сделки</th><th className="num">Сумма</th></tr></thead>
              <tbody>
                {rows.map((t, i) => (
                  <tr key={i}>
                    <td>{when(t.at)}</td>
                    <td><span className="chip">{TYPE[t.type] || t.type}</span></td>
                    <td className="muted wrap">{t.note}{t.meta?.account ? ` · счёт «${t.meta.account}»` : ""}</td>
                    <td className="num">{t.meta?.profit ? signed(t.meta.profit) : "—"}</td>
                    <td className={`num ${tone(t.amount)}`}><b>{signed(t.amount)}</b></td>
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
