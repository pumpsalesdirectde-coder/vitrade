import { useState } from "react";
import { post } from "../api.js";
import Brand from "../ui/Brand.jsx";

export default function Auth({ firstRun, onDone }) {
  const [mode, setMode] = useState(firstRun ? "register" : "login");
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
      await post(reg ? "/api/auth/register" : "/api/auth/login", form);
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
            <li><b>До 10 счетов</b><span>сравнивайте настройки бок о бок</span></li>
            <li><b>Запас до ликвидации</b><span>видно у каждой позиции в реальном времени</span></li>
          </ul>
        </div>
        <small className="muted">Данные хранятся на этом компьютере.</small>
      </section>

      <section className="auth-main">
        <form className="auth-form" onSubmit={submit}>
          <h2>{reg ? (firstRun ? "Создайте аккаунт владельца" : "Регистрация") : "Вход в кабинет"}</h2>
          {firstRun && reg && <p className="muted">Первому аккаунту достанутся счета и боты, перенесённые из прежней версии VITrade.</p>}
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
