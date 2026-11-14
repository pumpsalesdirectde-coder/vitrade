import { useState } from "react";
import { post } from "../api.js";
import { money, signed, tone, when } from "../format.js";

export default function Profile({ user, state, theme, setTheme, reload }) {
  const [name, setName] = useState(user.name);
  const [msg, setMsg] = useState("");
  const save = async (e) => {
    e.preventDefault();
    try {
      await post("/api/profile", { name });
      setMsg("Сохранено");
      reload();
    } catch (x) {
      setMsg(x.message);
    }
  };
  const active = state.accounts.filter((a) => !a.archived);
  const equity = active.reduce((s, a) => s + Number(a.equity), 0);
  const net = active.reduce((s, a) => s + Number(a.net), 0);
  const bots = active.reduce((s, a) => s + a.bots.length, 0);
  const trades = active.reduce((s, a) => s + a.cycles.filter((c) => c.status === "CLOSED").length, 0);

  return (
    <div className="profile">
      <section className="panel profile-card">
        <span className="avatar big-avatar" aria-hidden="true">{user.name.slice(0, 1).toUpperCase()}</span>
        <div>
          <h2>{user.name}</h2>
          <p className="muted">{user.email} · в MIVTrade с {when(user.createdAt)}</p>
        </div>
        <dl className="profile-nums">
          <div><dt>Капитал на счетах</dt><dd>{money(equity, 0)}</dd></div>
          <div><dt>Результат</dt><dd className={tone(net)}>{signed(net)}</dd></div>
          <div><dt>Ботов</dt><dd>{bots}</dd></div>
          <div><dt>Закрыто сделок</dt><dd>{trades}</dd></div>
        </dl>
      </section>

      <div className="two-col">
        <section className="panel">
          <h3 className="panel-title">Личные данные</h3>
          <form className="stack" onSubmit={save}>
            <label>Имя<input value={name} onChange={(e) => setName(e.target.value)} maxLength={64} required /></label>
            <label>Почта<input value={user.email} disabled /><small className="muted">Почта — логин для входа; сменить её пока нельзя.</small></label>
            <div className="form-actions"><button className="primary">Сохранить</button>{msg && <span className="muted">{msg}</span>}</div>
          </form>
        </section>

        <section className="panel">
          <h3 className="panel-title">Оформление</h3>
          <div className="choice">
            {[["dark", "Тёмная", "графит и мятный акцент"], ["light", "Светлая", "для яркого дня"]].map(([k, l, d]) => (
              <label key={k} className={theme === k ? "on" : ""}>
                <input type="radio" name="theme" checked={theme === k} onChange={() => setTheme(k)} /><b>{l}</b><span>{d}</span>
              </label>
            ))}
          </div>
          <h3 className="panel-title spaced">Уведомления</h3>
          <p className="muted small">Сейчас события видны в журнале счёта на «Обзоре». Уведомления в Telegram о ликвидации, низком запасе и закрытии сделок — в плане работ.</p>
        </section>
      </div>
    </div>
  );
}
