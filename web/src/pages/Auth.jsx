import { useState } from "react";
import { post } from "../api.js";
import Brand from "../ui/Brand.jsx";

// Код приглашения из ссылки ?ref=XXXX запоминаем, чтобы он не потерялся при переходах
function refCode() {
  const fromUrl = new URLSearchParams(location.search).get("ref");
  try {
    if (fromUrl) localStorage.setItem("mt-ref", fromUrl);
    return fromUrl || localStorage.getItem("mt-ref") || "";
  } catch {
    return fromUrl || "";
  }
}

export default function Auth({ firstRun, onDone }) {
  const [ref] = useState(refCode);
  const [mode, setMode] = useState(firstRun || ref ? "register" : "login");
  const [form, setForm] = useState({ email: "", name: "", password: "", repeat: "" });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const reg = mode === "register";

  const submit = async (e) => {
    e.preventDefault();
    setErr("");
    if (reg && form.password !== form.repeat) return setErr("Пароли не совпадают");
    setBusy(true);
    try {
      await post(reg ? "/api/auth/register" : "/api/auth/login", reg ? { ...form, ref } : form);
      onDone();
    } catch (x) {
      setErr(x.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <section className="auth-side">
        <Brand size={34} />
        <div className="auth-pitch">
          <h1>Тестируйте стратегии на живом рынке, не рискуя деньгами</h1>
          <p>Боты торгуют по реальным ценам Bybit на виртуальном счёте. Сетка докупок, стадии памп-цикла, RSI, фандинг и комиссии считаются так же, как на бирже.</p>
          <ul className="auth-points">
            <li><b>7 стратегий входа</b><span>от раннего разворота до отскока после обвала</span></li>
            <li><b>До 20 счетов</b><span>сравнивайте настройки бок о бок</span></li>
            <li><b>Запас до ликвидации</b><span>видно у каждой позиции в реальном времени</span></li>
          </ul>
        </div>
        <small className="muted">Торговля виртуальная: ордера на биржу не отправляются, деньги и ключи API не нужны.</small>
      </section>

      <section className="auth-main">
        <form className="auth-form" onSubmit={submit}>
          <h2>{reg ? "Регистрация" : "Вход в кабинет"}</h2>
          {reg && <p className="muted">После регистрации откроется кабинет с виртуальным счётом на 10 000 $.</p>}
          {reg && ref && <p className="ref-note">Вы регистрируетесь по приглашению <b>{ref.toUpperCase()}</b></p>}
          {reg && <label>Имя<input autoComplete="name" value={form.name} onChange={set("name")} required maxLength={64} /></label>}
          <label>Почта<input type="email" autoComplete="email" value={form.email} onChange={set("email")} required /></label>
          <label>Пароль<input type="password" autoComplete={reg ? "new-password" : "current-password"} value={form.password} onChange={set("password")} required minLength={reg ? 8 : 1} />
            {reg && <small className="muted">Не короче 8 символов, буквы и цифры</small>}
          </label>
          {reg && <label>Пароль ещё раз<input type="password" autoComplete="new-password" value={form.repeat} onChange={set("repeat")} required /></label>}
          {err && <div className="banner">{err}</div>}
          <button className="primary wide" disabled={busy}>{reg ? "Зарегистрироваться" : "Войти"}</button>
          {!firstRun && (
            <p className="auth-switch muted">
              {reg ? "Уже есть аккаунт? " : "Нет аккаунта? "}
              <button type="button" className="link" onClick={() => { setMode(reg ? "login" : "register"); setErr(""); }}>{reg ? "Войти" : "Зарегистрироваться"}</button>
            </p>
          )}
        </form>
      </section>
    </div>
  );
}
