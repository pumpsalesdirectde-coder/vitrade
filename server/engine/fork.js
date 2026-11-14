// Pure sizing/projection. The wallet commission is shared with actual billing.
import { D, Decimal, str, positive, free, liquidation, executionPrice, expectedResult, totalResult } from './accounting.js';
import { FEE_RATE } from '../wallet.js';

export const FORK_DEFAULTS = Object.freeze({
  enabled:true, rapidPct:'20', windowSeconds:60, totalPct:'50', stepPct:null,
  leverage:null, lossPct:'1', capMode:'multiple', capMultiple:'2', capAmount:'1000',
  extraLossPct:'3', maxMinutes:30,
});

export function normalizeFork(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('Некорректные настройки вилки');
  const s = {...FORK_DEFAULTS, ...Object.fromEntries(Object.keys(FORK_DEFAULTS).filter(k=>input[k]!==undefined).map(k=>[k,input[k]]))};
  if (typeof s.enabled !== 'boolean' || !['multiple','fixed'].includes(s.capMode)) throw Error('Некорректный режим вилки');
  for (const [k,min,max] of [['rapidPct',.01,1000],['totalPct',.01,1000],['lossPct',0,100],['capMultiple',.01,1000],['capAmount',1,1e7],['extraLossPct',.01,100]]) {
    try { const n=D(s[k]); if (!n.isFinite() || n.lt(min) || n.gt(max)) throw Error(); s[k]=str(n); }
    catch { throw Error(`Вилка: ${k} — от ${min} до ${max}`); }
  }
  for (const [k,min,max] of [['windowSeconds',5,14400],['maxMinutes',1,1440],['leverage',1,10]]) {
    if (k==='leverage' && s[k]===null) continue;
    if (!Number.isInteger(s[k]) || s[k]<min || s[k]>max) throw Error(`Вилка: ${k} — целое от ${min} до ${max}`);
  }
  if (s.stepPct!==null) {
    try {const n=D(s.stepPct); if (!n.isFinite() || n.lt('.01') || n.gt(100)) throw Error(); s.stepPct=str(n);}
    catch {throw Error('Вилка: шаг от 0.01 до 100%');}
  }
  return s;
}

export const freshForkQuote = (q,a,now) => !!q && q.source===a.source && positive(q.mark)
  && Number.isFinite(q.at) && q.at<=now+1000 && now-q.at<=15000;
export const executableForkQuote = (q,a,now) => freshForkQuote(q,a,now)
  && positive(q.bid) && positive(q.ask) && D(q.bid).lte(q.ask);
export const afterPlatform = n => D(n).minus(Decimal.max(0,n).times(FEE_RATE));
export const forkNet = (c,q) => c.status==='CLOSED' ? totalResult(c) : expectedResult(c,q);

export function observeFork(c,q,s) {
  if (q.at <= (c.forkLastObservedAt ?? -Infinity)) return;
  if (c.forkLastObservedAt!==undefined && q.at-c.forkLastObservedAt>15000) c.forkMarks=[];
  c.forkMarks ||= [];
  c.forkMarks.push([q.at,q.mark]);
  c.forkLastObservedAt=q.at;
  c.forkMarks=c.forkMarks.filter(([at])=>at>=q.at-s.windowSeconds*1000);
}

export function forkTrigger(c,q,s) {
  if (!s.enabled || c.direction!=='SHORT' || c.status!=='OPEN') return null;
  if (D(q.mark).gte(D(c.anchor).times(D(1).plus(D(s.totalPct).div(100))))) return 'TOTAL';
  const marks=c.forkMarks || [];
  if (marks.length<2) return null;
  const low=marks.reduce((m,[,p])=>Decimal.min(m,p),D(q.mark));
  return D(q.mark).gte(low.times(D(1).plus(D(s.rapidPct).div(100)))) ? 'RAPID' : null;
}

export function forkPlan(a,b,c,q,now,override) {
  const settings=normalizeFork(override ?? b.config.fork);
  const out={ok:false,reason:'Нет открытого шорта',settings};
  const reject=reason=>({...out,reason});
  if (!c || c.direction!=='SHORT' || c.status!=='OPEN' || !positive(c.quantity)) return out;
  Object.assign(out,{shortQuantity:c.quantity,shortAverage:c.average});
  if (!q || q.symbol!==c.symbol || !executableForkQuote(q,a,now)) return reject('Нет свежей исполнимой котировки');
  const step=D(settings.stepPct ?? c.config.spacingPct);
  const target=D(q.mark).times(D(1).plus(step.div(100)));
  const atTarget={...q,mark:str(target),bid:str(D(q.bid).times(target).div(q.mark)),ask:str(D(q.ask).times(target).div(q.mark))};
  const targetNet=D(c.config.budget).times(settings.lossPct).div(-100);
  const shortNet=forkNet(c,atTarget);
  const leverage=settings.leverage ?? c.config.leverage;
  const config={...c.config,leverage};
  const entry=executionPrice({direction:'LONG',config},q,true);
  const unit={direction:'LONG',quantity:'1',average:entry,realized:'0',fees:str(D(entry).times(config.feeRate)),funding:'0',status:'OPEN',config};
  const perUnit=forkNet(unit,atTarget);
  Object.assign(out,{stepPct:str(step),leverage,targetPrice:str(target),targetNet:str(targetNet),shortNet:str(shortNet)});
  if (afterPlatform(shortNet).gte(targetNet)) return reject('Шорт уже достигает цели без вилки');
  if (perUnit.lte(0)) return reject('Шаг не покрывает расходы на лонг');
  const qty=targetNet.minus(afterPlatform(shortNet)).div(afterPlatform(perUnit)).toDecimalPlaces(12,Decimal.ROUND_UP);
  const notional=qty.times(entry);
  const margin=notional.div(leverage);
  // Parent grid and unfilled additions are released only on successful pair creation.
  const available=free(a).plus(c.remainingBudget).plus(b.pending.reduce((sum,p)=>sum.plus(p.action==='add'?p.amount:0),D(0)));
  const cap=settings.capMode==='fixed'?D(settings.capAmount):D(c.config.budget).times(settings.capMultiple);
  const longNet=perUnit.times(qty);
  const platformFee=Decimal.max(0,shortNet).plus(Decimal.max(0,longNet)).times(FEE_RATE);
  Object.assign(out,{longQuantity:str(qty),longNotional:str(notional),margin:str(margin),available:str(available),cap:str(cap),longNet:str(longNet),platformFee:str(platformFee),net:str(shortNet.plus(longNet).minus(platformFee))});
  if (a.walletBlocked) return reject('Кошелёк в минусе — новые вилки заблокированы');
  if (a.fundingGaps.length) return reject('Ожидается сверка фандинга');
  if (target.gte(liquidation(c))) return reject('Цель выше порога ликвидации шорта');
  const longMargin=margin.minus(notional.times(config.feeRate));
  const longAtMark=D(q.mark).minus(entry).times(qty);
  if (longMargin.plus(longAtMark).lte(qty.times(q.mark).times('.005'))) return reject('Порог ликвидации лонга достигнут уже при входе');
  if (margin.gt(cap)) return reject('Требуемая маржа лонга превышает лимит');
  if (margin.gt(available) || margin.gt(a.cash)) return reject('Недостаточно свободных средств для полного лонга');
  if (D(out.net).lt(targetNet)) return reject('Не удалось достичь цели с заданной точностью');
  return {...out,ok:true,reason:'Расчёт доступен'};
}
