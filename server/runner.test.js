import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as immediate, setTimeout as sleep} from 'node:timers/promises';
import {openDatabase, insertAccount, getValue, readAccount, mutateAccount, setValue} from './db.js';
import {newAccount, createBot, command, advance, DEFAULT_CONFIG} from './engine/engine.js';
import * as runner from './runner.js';

function fixture() {
  const db=openDatabase(':memory:');
  for(let i=0;i<4;i++)insertAccount(db,newAccount(`a${i}`,'owner',`Account ${i}`,'market',0));
  return db;
}
const revisions=db=>db.prepare('SELECT revision FROM accounts ORDER BY position').all().map(r=>r.revision);

test('runner leaves the event loop available while processing accounts', async()=>{
  const db=fixture();
  const stop=runner.startRunner(db,()=>{throw Error('offline');},{offline:true});
  try {
    assert(revisions(db).some(r=>r===0),'startup must not synchronously process every account');
    for(let n=0;n<100&&!getValue(db,'worker:health',null);n++)await sleep(2);
    assert.equal(getValue(db,'worker:health',{}).processed,4);
    assert.deepEqual(revisions(db),[1,1,1,1]);
  } finally {stop();await immediate();db.close();}
});

test('stopping before the first pass prevents later database work',async()=>{
  const db=fixture();
  const stop=runner.startRunner(db,()=>{}, {offline:true});
  stop();
  await sleep(20);
  assert.deepEqual(revisions(db),[0,0,0,0]);
  db.close();
});

test('cooperative pass yields between transactions and respects a concurrent account edit',async()=>{
  const db=fixture();
  const run=runner.tickAccountsCooperatively(db,10000);
  assert.deepEqual(revisions(db),[1,0,0,0]);
  mutateAccount(db,'a1',a=>{a.name='Edited during pass';});
  await run;
  assert.deepEqual(revisions(db),[1,2,1,1]);
  assert.equal(readAccount(db,'a1').name,'Edited during pass');
  db.close();
});

test('stopping an in-flight pass does not touch the remaining accounts',async()=>{
  const db=fixture();let stopped=false;
  const run=runner.tickAccountsCooperatively(db,10000,()=>stopped);
  stopped=true;
  await run;
  assert.deepEqual(revisions(db),[1,0,0,0]);
  assert.equal(getValue(db,'worker:health',null),null);
  db.close();
});

test('cooperative processing preserves balances, fills, funding and pending commands',async()=>{
  const sync=openDatabase(':memory:'),cooperative=openDatabase(':memory:');
  const now=100000;
  const quotes={XUSDT:{symbol:'XUSDT',mark:'105',bid:'105',ask:'105',at:now,source:'market'}};
  for(let i=0;i<3;i++){
    const a=newAccount(`a${i}`,'owner','Economic fixture','market',0);
    const b=createBot(a,{...DEFAULT_CONFIG,mode:'manual',symbol:'XUSDT',direction:'SHORT',budget:'800',steps:8,spacingPct:'5',slippageRate:'0',fork:{enabled:false}},0);
    command(a,b.id,'start',{},0);
    advance(a,{XUSDT:{...quotes.XUSDT,mark:'100',bid:'100',ask:'100',at:1000}},1000);
    command(a,b.id,'partial',{percent:'25'},2000);
    for(const db of [sync,cooperative])insertAccount(db,structuredClone(a));
  }
  const funding=[{id:'XUSDT:5000',symbol:'XUSDT',at:5000,mark:'101',rate:'0.0001',recordedAt:5001}];
  for(const db of [sync,cooperative]){
    setValue(db,'market:quotes',quotes);setValue(db,'market:funding',funding);
    setValue(db,'market:fundingDue',[{symbol:'XUSDT',at:5000},{symbol:'XUSDT',at:7000}]);
  }
  runner.tickAccounts(sync,now);
  await runner.tickAccountsCooperatively(cooperative,now);
  const normalize=a=>({...a,events:a.events.map(({id,...rest})=>rest),fills:a.fills.map(({id,...rest})=>rest)});
  for(let i=0;i<3;i++)assert.deepEqual(normalize(readAccount(cooperative,`a${i}`)),normalize(readAccount(sync,`a${i}`)));
  sync.close();cooperative.close();
});

test('slow passes do not overlap and wait a full second after completion',async(t)=>{
  t.mock.timers.enable({apis:['setTimeout','setInterval']});
  const db=fixture();
  const stop=runner.startRunner(db,()=>{}, {offline:true});
  try{
    t.mock.timers.tick(0);
    assert.deepEqual(revisions(db),[1,0,0,0]);
    t.mock.timers.tick(5000);
    assert.deepEqual(revisions(db),[1,0,0,0]);
    for(let n=0;n<10;n++)await immediate();
    assert.deepEqual(revisions(db),[1,1,1,1]);
    t.mock.timers.tick(999);
    assert.deepEqual(revisions(db),[1,1,1,1]);
    t.mock.timers.tick(1);
    assert.deepEqual(revisions(db),[2,1,1,1]);
  }finally{stop();await immediate();db.close();}
});

for(const action of ['start','close'])test(`a ${action} command between accounts uses its actual time, price and funding boundary`,async()=>{
  const db=openDatabase(':memory:');
  insertAccount(db,newAccount('a0','owner','First','market',0));
  const a=newAccount('a1','owner','Second','market',0);
  const b=createBot(a,{...DEFAULT_CONFIG,mode:'manual',symbol:'XUSDT',direction:'SHORT',budget:'800',steps:8,orderPcts:undefined,slippageRate:'0',fork:{enabled:false}},0);
  const q={symbol:'XUSDT',mark:'100',bid:'100',ask:'100',at:10000,source:'market',nextFundingAt:10500,intervalHours:8};
  if(action==='close'){command(a,b.id,'start',{},1000);advance(a,{XUSDT:{...q,at:1000}},1000);}
  insertAccount(db,a);setValue(db,'market:quotes',{XUSDT:q});
  let now=10000;
  const run=runner.tickAccountsCooperatively(db,()=>now);
  now=11000;
  setValue(db,'market:quotes',{XUSDT:{...q,mark:'110',bid:'110',ask:'110',at:now}});
  mutateAccount(db,'a1',account=>command(account,b.id,action,{},now));
  await run;
  const updated=readAccount(db,'a1');
  if(action==='start'){
    assert(updated.cycles[0]?.openedAt>=11000);
    assert.equal(updated.fills[0].price,'110');
    setValue(db,'market:funding',[{id:'XUSDT:10500',symbol:'XUSDT',at:10500,mark:'100',rate:'0.01',recordedAt:12000}]);
    runner.tickAccounts(db,12000);
    const c=readAccount(db,'a1').cycles[0];
    assert(c.openedAt>=11000);
    assert.equal(c.average,'110');
    assert.equal(c.funding,'0');
  }else{
    assert(updated.cycles[0].closedAt>=11000);
    assert(updated.fills.at(-1).at>=11000);
    assert.equal(updated.fills.at(-1).price,'110');
    assert(updated.fundingGaps.includes('XUSDT:10500'));
    setValue(db,'market:funding',[{id:'XUSDT:10500',symbol:'XUSDT',at:10500,mark:'100',rate:'0.01',recordedAt:12000}]);
    runner.tickAccounts(db,12000);
    assert.equal(readAccount(db,'a1').cycles[0].funding,'5');
  }
  db.close();
});
