import { useEffect, useRef, useState } from "react";
import { signed, tone } from "../format.js";
import Icon from "./Icon.jsx";

const EXCHANGE_NAMES = { bybit: "Bybit", okx: "OKX", binance: "Binance", bitget: "Bitget", bingx: "BingX", hyperliquid: "Hyperliquid" };
export const exchangeName = (a) => EXCHANGE_NAMES[a.source] || EXCHANGE_NAMES[a.exchange] || "Bybit";
export const runningBots = (a) => a.bots.filter((b) => !b.forkParentId && b.enabled).length;

/** Выбор счёта: «Все счета» + счета, сгруппированные по биржам. */
export default function AccountSwitch({ accounts, value, onChange }) {
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  const all = value === "all";
  const current = accounts.find((a) => a.id === value);
  const totalNet = accounts.reduce((s, a) => s + Number(a.net), 0);
  const net = all ? totalNet : Number(current?.net ?? 0);

  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => !box.current?.contains(e.target) && setOpen(false);
    const esc = (e) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const choose = (id) => {
    onChange(id);
    setOpen(false);
  };
  const groups = {};
  for (const a of accounts) (groups[exchangeName(a)] ||= []).push(a);

  return (
    <div className="acc-switch" ref={box}>
      <button type="button" className="acc-trigger" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Icon name="layers" size={17} />
        <span className="acc-trigger-name">{all ? "Все счета" : current?.name}</span>
        <span className={`acc-trigger-net ${tone(net)}`}>{signed(net)}</span>
        <Icon name="chevron" size={16} />
      </button>
      {open && (
        <div className="acc-menu" role="listbox" aria-label="Счета">
          <button type="button" role="option" aria-selected={all} className={`acc-opt acc-all ${all ? "on" : ""}`} onClick={() => choose("all")}>
            <Icon name="layers" size={18} /><span className="acc-opt-name">Все счета</span>
            <span className={`acc-opt-net ${tone(totalNet)}`}>{signed(totalNet)}</span>
            {all && <Icon name="check" size={17} />}
          </button>
          {Object.entries(groups).map(([ex, list]) => (
            <div key={ex} className="acc-group">
              <div className="acc-group-head"><b>{ex}</b><a href="#/exchanges" onClick={() => setOpen(false)}>Все счета · {list.length} <Icon name="outlink" size={15} /></a></div>
              {list.map((a) => {
                const run = runningBots(a);
                return (
                  <button key={a.id} type="button" role="option" aria-selected={a.id === value} className={`acc-opt ${a.id === value ? "on" : ""}`} onClick={() => choose(a.id)}>
                    <span className="acc-opt-name">{a.name}</span>
                    <span className="acc-opt-mode">Paper</span>
                    <span className="acc-opt-bots" title="Работающих ботов">{run}</span>
                    <span className={`acc-pulse ${run ? "on" : ""}`} title={run ? "Боты работают" : "Боты не запущены"}><Icon name="pulse" size={14} /></span>
                    <span className={`acc-opt-net ${tone(a.net)}`}>{Number(a.net) ? signed(a.net) : "—"}</span>
                  </button>
                );
              })}
            </div>
          ))}
          <a className="acc-add" href="#/exchanges" onClick={() => setOpen(false)}><Icon name="plus" size={17} />Открыть счёт<Icon name="outlink" size={15} /></a>
        </div>
      )}
    </div>
  );
}
