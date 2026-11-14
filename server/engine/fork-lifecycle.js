import {randomUUID} from 'node:crypto';
import {D,Decimal,str,unrealized} from './accounting.js';
import {normalizeFork,forkPlan,forkNet,afterPlatform,observeFork,forkTrigger,freshForkQuote,executableForkQuote} from './fork.js';

export function pairView(a,f,q,now=Date.now()) {
  const s=a.cycles.find(c=>c.id===f.shortCycleId),l=a.cycles.find(c=>c.id===f.longCycleId);
  const executable=!!s && !!l && (f.status==='CLOSED' || executableForkQuote(q,a,now));
  if (!s || !l) return {...f,executable:false,net:null};
  // Without fresh executable quotes expose the last recorded result, not a fabricated current one.
  if (!executable) return {...f,...f.lastResult,executable:false};
  const sn=forkNet(s,q),ln=forkNet(l,q),net=afterPlatform(sn).plus(afterPlatform(ln));
  return {...f,shortNet:str(sn),longNet:str(ln),tradingNet:str(sn.plus(ln)),platformFee:str(sn.plus(ln).minus(net)),net:str(net),executable};
}

export function requestPairClose(f,reason) {
  if (f.status==='CLOSED') return;
  f.status='CLOSING';
  f.closeReason ||= reason;
}

export function advancePairs(a,quotes,now,ops) {
  for (const f of a.forks || []) {
    if (f.status==='CLOSED') continue;
    const legs=[f.shortCycleId,f.longCycleId].map(id=>a.cycles.find(c=>c.id===id));
    const q=quotes[f.symbol];
    if (now-f.openedAt>=f.settings.maxMinutes*60000) requestPairClose(f,'FORK_TIMEOUT');
    if (legs.some(c=>!c || c.status==='CLOSED')) requestPairClose(f,'FORK_ORPHAN');
    if (!freshForkQuote(q,a,now)) continue;
    for (const c of legs.filter(Boolean)) {
      if (c.status==='CLOSED') continue;
      c.lastMark=q.mark;
      if (D(c.margin).plus(unrealized(c,q.mark)).lte(D(c.quantity).times(q.mark).times('.005'))) {
        c.status='LIQUIDATING';
        requestPairClose(f,'FORK_LIQUIDATION');
      }
    }
    if (!executableForkQuote(q,a,now)) continue;
    if (f.status==='OPEN') {
      for (const c of legs) {
        const b=a.bots.find(b=>b.id===c.botId);
        ops.marginControl(a,b,c,q,now);
      }
      const v=pairView(a,f,q,now);
      f.lastResult={shortNet:v.shortNet,longNet:v.longNet,tradingNet:v.tradingNet,platformFee:v.platformFee,net:v.net};
      const stop=D(f.baselineNet).minus(D(f.budget).times(f.settings.extraLossPct).div(100));
      if (D(v.net).lte(stop)) requestPairClose(f,'FORK_STOP');
      else if (!a.fundingGaps.length && D(v.net).gte(f.targetNet)) requestPairClose(f,'FORK_TARGET');
    }
    if (f.status==='CLOSING') {
      for (const c of legs.filter(Boolean)) {
        const b=a.bots.find(b=>b.id===c.botId);
        if (!b) continue;
        b.finish=true; b.pending=[];
        if (c.status!=='CLOSED') ops.reduce(a,b,c,q,'100',f.closeReason,now);
        if (c.status==='CLOSED') b.enabled=false;
      }
      if (legs.filter(Boolean).every(c=>c.status==='CLOSED')) {
        f.status='CLOSED'; f.closedAt=now;
        const view=pairView(a,f,q,now);
        ops.event(a,'FORK_CLOSED','Вилка: обе позиции закрыты',now,null,null,view.net);
      }
    }
  }
}

export function tryOpenFork(a,b,c,q,now,ops) {
  if (b.forkParentId || c.forkId || c.direction!=='SHORT' || c.status!=='OPEN') return false;
  const settings=normalizeFork(b.config.fork);
  observeFork(c,q,settings);
  if (!settings.enabled) {b.forkStatus='Вилка выключена';return false;}
  const trigger=forkTrigger(c,q,settings);
  if (!trigger) {b.forkStatus='Ожидает роста цены';return false;}
  if (forkNet(c,q).gte(0)) {b.forkStatus='Шорт не убыточен';return false;}
  const plan=forkPlan(a,b,c,q,now);
  if (!plan.ok) {
    if (b.forkStatus!==plan.reason) ops.event(a,'FORK_BLOCKED',plan.reason,now,b,c);
    b.forkStatus=plan.reason;
    return false;
  }
  const f={id:randomUUID(),parentBotId:b.id,shortCycleId:c.id,symbol:c.symbol,status:'OPEN',openedAt:now,closedAt:null,closeReason:null,trigger,targetPrice:plan.targetPrice,targetNet:plan.targetNet,settings,budget:c.config.budget,plan};
  const child={id:randomUUID(),forkParentId:b.id,config:{...structuredClone(c.config),name:`Вилка · ${b.config.name}`.slice(0,64),mode:'manual',symbol:c.symbol,direction:'LONG',budget:plan.margin,leverage:plan.leverage,steps:1,marginAuto:false,guardOn:false,fork:{...settings,enabled:false}},version:1,enabled:true,paused:false,finish:true,currentCycleId:null,activatedAt:now,lastSignal:{},lastReason:'Лонг вилки',pending:[]};
  const long={id:randomUUID(),botId:child.id,forkId:f.id,symbol:c.symbol,direction:'LONG',stage:'FORK',config:structuredClone(child.config),version:1,status:'OPEN',quantity:'0',average:'0',anchor:'0',margin:'0',initialMargin:'0',extraMargin:'0',remainingBudget:'0',usedSteps:0,realized:'0',fees:'0',funding:'0',openedAt:now,closedAt:null,closeReason:null,lastMark:q.mark};
  // Exact computed quantity avoids double rounding through the margin-to-quantity conversion.
  if (!ops.increase(a,child,long,q,plan.margin,false,now,plan.longQuantity)) return false;
  long.usedSteps=1;
  const fill=a.fills.at(-1); if (fill) fill.reason='FORK';
  if (b.pending.length) ops.event(a,'FORK_CANCEL_PENDING','Вилка: отложенные команды отменены',now,b,c);
  b.pending=[]; c.remainingBudget='0'; c.dcaLocked=true; c.forkId=f.id;
  child.currentCycleId=long.id;
  a.bots.push(child); a.cycles.push(long);
  f.childBotId=child.id;f.longCycleId=long.id;
  f.baselineNet=pairView(a,f,q,now).net;
  (a.forks ||= []).push(f);
  b.forkStatus='Вилка открыта'; b.lastReason='Вилка: совместное сопровождение шорта и лонга';
  ops.event(a,'FORK_OPENED',`Вилка: лонг ${plan.longQuantity}, цель ${plan.targetPrice}`,now,b,c,plan.margin);
  return true;
}
