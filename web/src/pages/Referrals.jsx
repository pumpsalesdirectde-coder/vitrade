import { useState } from "react";
import { usePoll } from "../api.js";
import { money, when } from "../format.js";

export default function Referrals() {
  const { data } = usePoll("/api/referrals", 20000);
  const [copied, setCopied] = useState("");
  if (!data) return <p className="muted">Загрузка…</p>;
  const link = `${location.origin}/?ref=${data.code}`;
  const pct = Math.round(data.refRate * 100);
  const fee = Math.round(data.feeRate * 100);
  const copy = async (text, what) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied(""), 2000);
    } catch {
      setCopied("");
    }
  };
  const share = async () => {
    if (navigator.share) {
      try {
        await navigator.share({ title: "MIVTrade", text: "Тестирую торговых ботов на MIVTrade — присоединяйся", url: link });
      } catch { /* пользователь закрыл окно */ }
    } else copy(link, "link");
  };

  return (
    <div className="referrals">
      <section className="panel ref-hero">
        <div className="ref-pitch">
          <h2>Приглашайте друзей и получайте {pct}% с комиссии площадки</h2>
          <p className="muted">Когда приглашённый закрывает прибыльную сделку, площадка берёт {fee}% с прибыли, а {pct}% от этой комиссии
            зачисляется на ваш кошелёк. Без ограничения по сроку и числу приглашённых.</p>
        </div>
        <div className="ref-link">
          <label>Ваша ссылка
            <div className="copy-row">
              <input readOnly value={link} onFocus={(e) => e.target.select()} />
              <button className="primary" onClick={() => copy(link, "link")}>{copied === "link" ? "Скопировано" : "Копировать"}</button>
            </div>
          </label>
          <div className="copy-row small-row">
            <span className="muted">Код приглашения</span>
            <b className="ref-code">{data.code}</b>
            <button className="ghost" onClick={() => copy(data.code, "code")}>{copied === "code" ? "Скопировано" : "Копировать код"}</button>
            <button className="ghost" onClick={share}>Поделиться</button>
          </div>
        </div>
      </section>

      <div className="tiles three">
        <div className="tile"><span>Приглашено</span><b>{data.stats.invited}</b><small>зарегистрировались по ссылке</small></div>
        <div className="tile"><span>Активные</span><b>{data.stats.active}</b><small>закрыли хотя бы одну сделку</small></div>
        <div className="tile"><span>Заработано</span><b className="up">{money(data.stats.earned)}</b><small>зачислено на кошелёк</small></div>
      </div>

      <section className="panel">
        <h3 className="panel-title">Как это работает</h3>
        <ol className="steps-list">
          <li><b>Отправьте ссылку</b> другу или опубликуйте её.</li>
          <li><b>Друг регистрируется</b> по ссылке и запускает ботов.</li>
          <li><b>С каждой его прибыльной сделки</b> площадка берёт {fee}% прибыли, из них {pct}% — ваши. Пример: друг заработал 100 $, комиссия {money(100 * data.feeRate)}, вам {money(100 * data.feeRate * data.refRate)}.</li>
          <li><b>Вознаграждение приходит на кошелёк</b> автоматически и уменьшает вашу собственную комиссию.</li>
        </ol>
      </section>

      <section className="block">
        <header className="block-head"><h2>Приглашённые <span className="count">{data.invited.length}</span></h2></header>
        {data.invited.length === 0 ? <p className="empty-line">Пока никто не зарегистрировался по вашей ссылке.</p> : (
          <div className="table-wrap">
            <table className="grid-table">
              <thead><tr><th>Пользователь</th><th>Регистрация</th><th>Статус</th><th className="num">Сделок закрыто</th><th className="num">Оплачено сделок</th><th className="num">Ваш доход</th></tr></thead>
              <tbody>
                {data.invited.map((u, i) => (
                  <tr key={i}>
                    <td><strong>{u.name}</strong><small className="sub muted">{u.email}</small></td>
                    <td>{when(u.joinedAt)}</td>
                    <td><span className={`state ${u.active ? "live" : "off"}`}>{u.active ? "Активен" : "Ещё не торговал"}</span></td>
                    <td className="num">{u.trades}</td>
                    <td className="num">{u.paidTrades}</td>
                    <td className="num up"><b>{money(u.rewards)}</b></td>
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
