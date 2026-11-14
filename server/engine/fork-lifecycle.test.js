import {test} from 'node:test';
import assert from 'node:assert/strict';
import {advance,command,createBot,newAccount,DEFAULT_CONFIG,summarize} from './engine.js';
import {D,free} from './accounting.js';
const quotes=(p,t)=>({XUSDT:{symbol:'XUSDT',mark:String(p),bid:String(p),ask:String(p),source:'market',at:t}});
function setup(fork={}) {
  const a=newAccount('a','u','test','market',0,'bybit','100000');
  const b=createBot(a,{...DEFAULT_CONFIG,mode:'manual',symbol:'XUSDT',budget:'1000',leverage:1,steps:4,spacingPct:'10',tpPct:'100',slPct:'1000',marginAuto:false,guardOn:false,feeRate:'0.00055',slippageRate:'0.0002',fork:{capMode:'fixed',capAmount:'50000',stepPct:'10',...fork}},0);
  command(a,b.id,'start',{},0); advance(a,quotes(10,1000),1000);
  return {a,b};
}
function opened() {const x=setup(); advance(x.a,quotes(11,5000),5000); advance(x.a,quotes(12.1,10000),10000); return x;}
test('rapid fork uses all executed DCA, creates once and closes both at projected target',()=>{
  const {a,b}=opened(); const f=a.forks?.[0]; assert.ok(f,'fork must exist');
  const s=a.cycles.find(c=>c.id===f.shortCycleId),l=a.cycles.find(c=>c.id===f.longCycleId);
  assert.equal(s.usedSteps,2); assert.equal(f.plan.shortQuantity,s.quantity); assert.ok(D(l.quantity).gt(s.quantity));
  assert.equal(s.remainingBudget,'0'); assert.ok(free(a).gte(0));
  advance(a,quotes(12.1,11000),11000); assert.equal(a.forks.length,1);
  assert.throws(()=>command(a,b.id,'add',{amount:'1'}),/вилк/i);
  assert.throws(()=>command(a,f.childBotId,'partial',{percent:50}),/вилк/i);
  advance(a,quotes(f.targetPrice,12000),12000);
  assert.equal(f.status,'CLOSED'); assert.equal(f.closeReason,'FORK_TARGET');
  assert.equal(s.status,'CLOSED');assert.equal(l.status,'CLOSED');
  assert.equal(b.enabled,false); assert.equal(a.bots[1].enabled,false);
  const view=summarize(a,quotes(f.targetPrice,12000)).forks[0]; assert.ok(D(view.net).gte(f.targetNet));
  assert.throws(()=>command(a,f.childBotId,'start'),/вилк/i);
});
test('total growth independently triggers; disabled fork never opens',()=>{
  for (const enabled of [true,false]) {
    const {a}=setup({enabled,rapidPct:'1000',totalPct:'10'});
    advance(a,quotes(11,30000),30000);
    assert.equal(a.forks?.length||0,enabled?1:0);
  }
});
test('active fork survives JSON restart and disabled setting; manual close closes both',()=>{
  const x=opened(); const a=JSON.parse(JSON.stringify(x.a)); const f=a.forks[0];
  command(a,x.b.id,'fork-settings',{enabled:false},11000);
  advance(a,quotes(12.1,12000),12000);assert.equal(f.status,'OPEN');
  command(a,f.childBotId,'close',{},13000); advance(a,quotes(12.1,14000),14000);
  assert.equal(f.status,'CLOSED');assert.ok(a.cycles.every(c=>c.status==='CLOSED'));
});
test('additional loss and timeout close both, timeout waits for executable quote',()=>{
  const {a}=opened(); const f=a.forks[0]; advance(a,quotes(11,12000),12000);
  assert.equal(f.status,'CLOSED'); assert.equal(f.closeReason,'FORK_STOP');
  const x=opened(); const pair=x.a.forks[0]; const t=pair.openedAt+31*60000;
  advance(x.a,{},t); assert.equal(pair.status,'CLOSING');
  advance(x.a,quotes(12.1,t+1000),t+1000); assert.equal(pair.status,'CLOSED');assert.equal(pair.closeReason,'FORK_TIMEOUT');
});
test('insufficient budget preserves short grid reserves, no partial hedge',()=>{
  const {a,b}=setup({capMode:'fixed',capAmount:'1'});
  advance(a,quotes(12.1,5000),5000);
  assert.equal(a.forks?.length||0,0);assert.equal(a.bots.length,1);
  assert.match(b.forkStatus,/лимит/);assert.ok(D(a.cycles[0].remainingBudget).gte(0));
});

test('liquidation of one leg forces closure of the pair; no orphan exposure',()=>{
  const {a}=opened(); const f=a.forks[0];
  advance(a,quotes(25,12000),12000);
  assert.equal(f.status,'CLOSED'); assert.equal(f.closeReason,'FORK_LIQUIDATION');
  assert.ok(a.cycles.every(c=>c.status==='CLOSED'));
});
test('invalid or stale quotes cannot open or execute a pair',()=>{
  const {a}=setup();
  const invalid=quotes(12.1,5000); invalid.XUSDT.bid='13';
  advance(a,invalid,5000); assert.equal(a.forks?.length||0,0);
  const x=opened(); const f=x.a.forks[0];
  command(x.a,f.parentBotId,'close',{},12000);
  advance(x.a,quotes(12.1,10000),30000);assert.equal(f.status,'CLOSING');
  advance(x.a,quotes(12.1,31000),31000);assert.equal(f.status,'CLOSED');
});
test('other bot reservations and negative wallet prevent funding a hedge',()=>{
  const {a,b}=setup(); a.cash='2750';
  const other=createBot(a,{...DEFAULT_CONFIG,budget:'2000',fork:{enabled:false}},2000);
  command(a,other.id,'start',{},2000);
  advance(a,quotes(12.1,5000),5000);
  assert.equal(a.forks?.length||0,0); assert.match(b.forkStatus,/средств/);
  const x=setup(); x.a.walletBlocked=true; advance(x.a,quotes(12.1,5000),5000);
  assert.equal(x.a.forks?.length||0,0);assert.match(x.b.forkStatus,/Кошелёк/);
});
test('zero-loss target includes accrued funding and wallet fee',()=>{
  const {a}=setup({lossPct:'0'}); a.cycles[0].funding='-2';a.cycles[0].margin=D(a.cycles[0].margin).minus(2).toFixed();
  advance(a,quotes(12.1,5000),5000);const f=a.forks[0];assert.ok(f);
  advance(a,quotes(D(f.targetPrice).plus('.000001').toFixed(),10000),10000);
  assert.equal(f.closeReason,'FORK_TARGET');
  assert.ok(D(summarize(a,{}).forks[0].net).gte(0));
});
