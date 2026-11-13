import { useState } from "react";
import { post, usePoll } from "../api.js";
import { when } from "../format.js";

/** Браузер и система из строки User-Agent простыми словами. */
function device(agent) {
  const b = /Edg\//.test(agent) ? "Edge" : /OPR\//.test(agent) ? "Opera" : /Firefox\//.test(agent) ? "Firefox" : /Chrome\//.test(agent) ? "Chrome" : /Safari\//.test(agent) ? "Safari" : "Браузер";
  const os = /Windows/.test(agent) ? "Windows" : /Android/.test(agent) ? "Android" : /iPhone|iPad/.test(agent) ? "iOS" : /Mac OS/.test(agent) ? "macOS" : /Linux/.test(agent) ? "Linux" : "";
  return os ? `${b} · ${os}` : b;
}

export default function Security() {
  const { data, reload } = usePoll("/api/security", 30000);
  const [pw, setPw] = useState({ current: "", next: "", repeat: "" });
  const [msg, setMsg] = useState("");
  const change = async (e) => {
    e.preventDefault();
    if (pw.next !== pw.repeat) return setMsg("Новые пароли не совпадают");
    try {
      await post("/api/auth/password", { current: pw.current, next: pw.next });
      setPw({ current: "", next: "", repeat: "" });
      setMsg("Пароль изменён. Остальные сеансы завершены.");
      reload();
    } catch (x) {
      setMsg(x.message);
    }
  };
  const end = async (path) => {
    await post(path).catch(() => {});
    reload();
  };
  const others = (data?.sessions || []).filter((s) => !s.current).length;

  return (
    <div className="security">
      <div className="two-col">
        <section className="panel">
          <h3 className="panel-title">Пароль</h3>
          <form className="stack" onSubmit={change}>
            <label>Текущий пароль<input type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} required /></label>
            <label>Новый пароль<input type="password" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} required minLength={8} /><small className="muted">Не короче 8 символов, буквы и цифры</small></label>
            <label>Новый пароль ещё раз<input type="password" autoComplete="new-password" value={pw.repeat} onChange={(e) => setPw({ ...pw, repeat: e.target.value })} required /></label>
            <div className="form-actions"><button className="primary">Сменить пароль</button>{msg && <span className="muted">{msg}</span>}</div>
          </form>
        </section>
        <section className="panel">
          <h3 className="panel-title">Защита входа</h3>
          <ul className="checklist">
            <li className="ok">Пароль хранится только в виде стойкого хэша (scrypt)</li>
            <li className="ok">Сессия — в защищённой cookie, недоступной скриптам страниц</li>
            <li className="ok">Действия в кабинете принимаются только с этого сайта</li>
            <li className="ok">После 8 неверных паролей вход блокируется на 15 минут</li>
            <li>Двухфакторная защита (код из приложения) — в плане работ</li>
          </ul>
        </section>
      </div>

      <section className="panel">
        <header className="panel-head">
          <h3 className="panel-title">Устройства и сеансы <span className="count">{data?.sessions.length ?? ""}</span></h3>
          {others > 0 && <button onClick={() => end("/api/security/sessions/end-others")}>Завершить другие ({others})</button>}
        </header>
        <div className="table-wrap">
          <table className="grid-table">
            <thead><tr><th>Устройство</th><th>Адрес</th><th>Вход</th><th>Активность</th><th /></tr></thead>
            <tbody>
              {(data?.sessions || []).map((s) => (
                <tr key={s.id}>
                  <td><strong>{device(s.agent)}</strong>{s.current && <span className="chip">это устройство</span>}</td>
                  <td className="muted">{s.ip}</td>
                  <td>{when(s.createdAt)}</td>
                  <td>{when(s.lastSeen)}</td>
                  <td>{!s.current && <button className="ghost danger-text" onClick={() => end(`/api/security/sessions/${s.id}/end`)}>Завершить</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <h3 className="panel-title">История входов</h3>
        <div className="table-wrap">
          <table className="grid-table compact">
            <thead><tr><th>Когда</th><th>Результат</th><th>Устройство</th><th>Адрес</th></tr></thead>
            <tbody>
              {(data?.logins || []).map((l) => (
                <tr key={l.at}>
                  <td>{when(l.at)}</td>
                  <td className={l.ok ? "up" : "down"}>{l.ok ? "Успешно" : "Неверный пароль"}</td>
                  <td>{device(l.agent)}</td>
                  <td className="muted">{l.ip}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
