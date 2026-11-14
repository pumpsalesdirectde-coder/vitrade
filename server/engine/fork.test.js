import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFork, forkPlan, observeFork, forkTrigger } from './fork.js';
import { D } from './accounting.js';

function fixture() {
  const config = { budget:'1000', spacingPct:'10', leverage:5, feeRate:'0.00055', slippageRate:'0.0002' };
  const c = { id:'c', direction:'SHORT', symbol:'XUSDT', status:'OPEN', quantity:'100', average:'10', anchor:'10', margin:'1000', remainingBudget:'100', realized:'0', funding:'0', fees:'0.55', config };
  const b = {id:'b',currentCycleId:'c',pending:[],config:{...config,fork:normalizeFork({enabled:true,capMode:'fixed',capAmount:'10000'})}};
  const a = {cash:'10000',source:'market',bots:[b],cycles:[c],fundingGaps:[]};
  const q = {symbol:'XUSDT',mark:'12',bid:'12',ask:'12',source:'market',at:1000};
  return {a,b,c,q};
}

test('dynamic size covers all short and platform fees at target', () => {
  const {a,b,c,q} = fixture();
  const p = forkPlan(a,b,c,q,1000,{...b.config.fork,lossPct:'2'});
  assert.equal(p.ok,true);
  assert.equal(p.targetPrice,'13.2');
  assert.ok(D(p.longQuantity).gt(319));
  assert.ok(D(p.net).gte(-20));
  assert.ok(D(p.net).lt('-19.99999'));
  c.quantity='200'; c.margin='2000';
  const twice=forkPlan(a,b,c,q,1000);
  assert.ok(D(twice.longQuantity).gt(p.longQuantity));
  c.quantity='50';
  assert.ok(D(forkPlan(a,b,c,q,1000).longQuantity).lt(p.longQuantity));
});
test('size refuses unavailable capital, limits, stale quotes and unreachable target',()=>{
  const {a,b,c,q}=fixture();
  assert.equal(forkPlan(a,b,c,q,17000).ok,false);
  assert.equal(forkPlan(a,b,c,{...q,bid:'13'},1000).ok,false);
  assert.equal(forkPlan(a,b,c,q,1000,{...b.config.fork,capAmount:'1'}).ok,false);
  a.cash='2'; assert.equal(forkPlan(a,b,c,q,1000).ok,false);
  a.cash='10000'; c.margin='100';
  assert.match(forkPlan(a,b,c,q,1000).reason,/ликвидац/);
});
test('fork defaults and numeric validation',()=>{
  assert.equal(normalizeFork().enabled,false);
  assert.equal(normalizeFork().rapidPct,'20');
  for (const input of [{rapidPct:'NaN'},{windowSeconds:0},{stepPct:0},{enabled:'yes'},{capMode:'bad'},{leverage:11},{lossPct:-1}]) assert.throws(()=>normalizeFork(input));
});
test('never open a long already beyond maintenance margin due to mark/book divergence',()=>{
  const {a,b,c,q}=fixture();
  const result=forkPlan(a,b,c,{...q,bid:'13.4',ask:'13.4'},1000,{...b.config.fork,leverage:10});
  assert.equal(result.ok,false);
  assert.match(result.reason,/ликвидац.*лонг/);
});
test('observations use unique quotes, reset after gap; trigger is OR',()=>{
  const {c,q}=fixture(); const s=normalizeFork({enabled:true});
  observeFork(c,{...q,mark:'10'},s);
  observeFork(c,{...q,mark:'12',at:6000},s);
  assert.equal(forkTrigger(c,{...q,mark:'12'},s),'RAPID');
  observeFork(c,{...q,mark:'12',at:6000},s);
  assert.equal(c.forkMarks.length,2);
  observeFork(c,{...q,mark:'12',at:30000},s);
  assert.equal(c.forkMarks.length,1);
  assert.equal(forkTrigger(c,{...q,mark:'12'},s),null);
  assert.equal(forkTrigger(c,{...q,mark:'15'},s),'TOTAL');
});
