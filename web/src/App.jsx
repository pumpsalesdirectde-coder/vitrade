import { useEffect, useState } from "react";
import { post, useAppState, useSession } from "./api.js";
import { money } from "./format.js";
import Brand from "./ui/Brand.jsx";
import Icon from "./ui/Icon.jsx";
import Auth from "./pages/Auth.jsx";
import Overview from "./pages/Overview.jsx";
import Bots from "./pages/Bots.jsx";
import Fork from "./pages/Fork.jsx";
import Trades from "./pages/Trades.jsx";
import BotForm from "./pages/BotForm.jsx";
import Screener from "./pages/Screener.jsx";
import Stats from "./pages/Stats.jsx";
import Exchanges from "./pages/Exchanges.jsx";
import Profile from "./pages/Profile.jsx";
import Security from "./pages/Security.jsx";
import Guide from "./pages/Guide.jsx";
import Wallet from "./pages/Wallet.jsx";
import Referrals from "./pages/Referrals.jsx";
import Hint from "./ui/Hint.jsx";
import AccountSwitch from "./ui/AccountSwitch.jsx";
import AllAccounts from "./pages/AllAccounts.jsx";

const MENU = [
  ["Торговля", [["overview", "Обзор"], ["screener", "Чекер"], ["bots", "Боты"], ["fork", "Вилка"], ["river-simulator", "Симулятор RIVER"], ["trades", "Сделки"], ["stats", "Статистика"]]],
  ["Счета", [["exchanges", "Биржи и счета"]]],
  ["Финансы", [["wallet", "Кошелёк"], ["referrals", "Рефералы"]]],
  ["Аккаунт", [["profile", "Профиль и настройки"], ["security", "Безопасность"]]],
  ["Помощь", [["guide", "Гайд"]]],
];
const TITLES = Object.fromEntries(MENU.flatMap(([, items]) => items));
// разделы, где показывается выбор счёта
const ACCOUNT_PAGES = new Set(["overview", "bots", "fork", "trades", "stats", "new", "edit"]);
// разделы, где доступна сводка «Все счета»; остальным нужен конкретный счёт
const ALL_PAGES = new Set(["overview", "bots", "trades", "stats"]);

function useHash() {
  const read = () => (location.hash.replace(/^#\/?/, "") || "overview").split("/");
  const [parts, setParts] = useState(read);
  useEffect(() => {
    const on = () => setParts(read());
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return parts;
}

const store = {
  get: (k, d) => {
    try {
      return localStorage.getItem(k) ?? d;
    } catch {
      return d;
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem(k, v);
    } catch { /* без сохранения */ }
  },
};

export function useTheme() {
  const [theme, setTheme] = useState(() => store.get("vt-theme", "dark"));
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    store.set("vt-theme", theme);
  }, [theme]);
  return [theme, setTheme];
}

function MarketStatus({ market }) {
  const age = market?.at ? (Date.now() - market.at) / 1000 : Infinity;
  const ok = market?.status === "connected" && age < 30;
  return (
    <span className={`market ${ok ? "ok" : "bad"}`} title={market?.message || ""}>
      <i aria-hidden="true" />
      {ok ? `Bybit · ${market.symbols} монет` : market?.status === "starting" ? "Подключение…" : "Нет данных рынка"}
    </span>
  );
}

export default function App() {
  const [session, reloadSession] = useSession();
  const [theme, setTheme] = useTheme();
  const user = session?.user;
  const { state, error, refresh } = useAppState(!!user);
  const [page, ...rest] = useHash();
  const [menuOpen, setMenuOpen] = useState(false);
  const [accountId, setAccountId] = useState(() => store.get("vt-account", ""));

  useEffect(() => setMenuOpen(false), [page]);

  if (session === undefined) return <div className="splash"><Brand size={34} /></div>;
  if (!user) return <Auth firstRun={session.firstRun} onDone={reloadSession} />;

  const accounts = (state?.accounts || []).filter((a) => !a.archived);
  const all = accountId === "all" && accounts.length > 0;
  const account = accounts.find((a) => a.id === accountId) || accounts[0];
  const pick = (id) => {
    setAccountId(id);
    store.set("vt-account", id);
    if (page === "fork" && id !== account?.id) location.hash = "#/fork";
  };
  const logout = async () => {
    await post("/api/auth/logout").catch(() => {});
    reloadSession();
  };
  const current = page === "new" || page === "edit" ? "bots" : page;
  const title = page === "new" ? "Новый бот" : page === "edit" ? "Настройки бота" : TITLES[page] || "Обзор";
  const needsAccount = ACCOUNT_PAGES.has(page) || !TITLES[page];
  const showAll = all && (ALL_PAGES.has(page) || !TITLES[page]);

  let content;
  if (!state) content = <p className="muted">Загрузка…</p>;
  else if (needsAccount && !account) {
    content = (
      <div className="empty-state">
        <h2>Откройте первый бумажный счёт</h2>
        <p className="muted">На счёте живут боты и их сделки. Капитал виртуальный, цены — реальные с Bybit.</p>
        <a className="btn primary" href="#/exchanges">Открыть счёт</a>
      </div>
    );
  } else if (showAll) {
    content = <AllAccounts accounts={accounts} page={page} onPick={pick} />;
  } else {
    content = {
      overview: <Overview account={account} />,
      screener: <Screener state={state} />,
      bots: <Bots account={account} refresh={refresh} />,
      fork: <Fork key={account?.id} account={account} accounts={accounts} onPick={pick} state={state} botId={rest[0]} refresh={refresh} />,
      trades: <Trades account={account} />,
      stats: <Stats account={account} accounts={accounts} />,
      exchanges: <Exchanges state={state} refresh={refresh} onPick={pick} />,
      profile: <Profile user={user} state={state} theme={theme} setTheme={setTheme} reload={reloadSession} />,
      security: <Security />,
      guide: <Guide topic={rest[0]} />,
      wallet: <Wallet refresh={refresh} />,
      referrals: <Referrals />,
      new: <BotForm key={`${account?.id}:new`} account={account} state={state} refresh={refresh} />,
      edit: <BotForm key={`${account?.id}:${rest[0]}`} account={account} state={state} botId={rest[0]} refresh={refresh} />,
    }[page] || <Overview account={account} />;
  }

  return (
    <div className={`shell ${menuOpen ? "menu-open" : ""}`}>
      <aside className="sidebar">
        <a className="side-brand" href="#/overview"><Brand /></a>
        <nav aria-label="Разделы">
          {MENU.map(([group, items]) => (
            <div key={group} className="nav-group">
              <span className="nav-label">{group}</span>
              {items.map(([id, label]) => (
                <a key={id} href={id === "river-simulator" ? "/river-simulator.html" : `#/${id}`} aria-current={current === id ? "page" : undefined}>
                  <Icon name={id === "river-simulator" ? "stats" : id} />{label}
                  {id === "wallet" && state?.wallet && <span className={`nav-badge ${state.wallet.balance < 0 ? "down" : ""}`}>{money(state.wallet.balance)}</span>}
                  {id === "referrals" && state?.wallet && <span className="nav-badge count">{state.wallet.referrals ?? 0}</span>}
                </a>
              ))}
            </div>
          ))}
        </nav>
        <div className="side-user">
          <span className="avatar" aria-hidden="true">{user.name.slice(0, 1).toUpperCase()}</span>
          <span className="who"><b>{user.name}</b><small>{user.email}</small></span>
          <button className="ghost icon" onClick={logout} title="Выйти"><Icon name="logout" /></button>
        </div>
      </aside>
      <button className="scrim" aria-label="Закрыть меню" onClick={() => setMenuOpen(false)} />

      <div className="workspace">
        <header className="topbar">
          <button className="ghost icon burger" onClick={() => setMenuOpen(true)} aria-label="Меню"><Icon name="menu" /></button>
          <h1>{title}</h1>
          {needsAccount && accounts.length > 0 && (
            <AccountSwitch accounts={accounts} value={showAll ? "all" : account?.id} onChange={pick} />
          )}
          <div className="top-right">
            {state?.wallet && <a className={`wallet-chip ${state.wallet.balance < 0 ? "minus" : ""}`} href="#/wallet" title="Баланс кошелька"><Icon name="wallet" size={15} />{money(state.wallet.balance)}</a>}
            <MarketStatus market={state?.market} />
            <Hint term="paper"><span className="paper">Paper</span></Hint>
          </div>
        </header>
        {error && <div className="banner">{error}</div>}
        {state?.wallet?.balance < 0 && <div className="banner">Баланс кошелька отрицательный ({money(state.wallet.balance)}): боты не открывают новые сделки. <a href="#/wallet">Пополнить кошелёк</a></div>}
        {needsAccount && !showAll && account?.reserveShortfall && <div className="banner">На счёте не хватает свободных средств под бюджеты ботов — новые сделки и докупки остановлены.</div>}
        <main>{content}</main>
        {needsAccount && !showAll && account && <footer className="foot">Капитал счёта «{account.name}»: <b>{money(account.equity)}</b></footer>}
      </div>
    </div>
  );
}
