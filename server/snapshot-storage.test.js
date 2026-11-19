import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDatabase,insertAccount,readAccount,listAccounts,mutateAccount,transaction,setValue,deleteAccount,deleteExchangeAccounts} from './db.js';
import {newAccount,advance,createBot,command,DEFAULT_CONFIG} from './engine/engine.js';
import {tickAccounts} from './runner.js';
import {createForkTestAccounts} from '../scripts/create-fork-tests.js';

const points=n=>Array.from({length:n},(_,i)=>({at:i*5000,equity:String(10000+i/10)}));
const stored=(db,id)=>JSON.parse(db.prepare('SELECT state FROM accounts WHERE id=?').get(id).state);
const thin=(xs,n=240)=>xs.length<=n?xs:Array.from({length:n},(_,i)=>xs[Math.floor(i*(xs.length/n))]).concat(xs.at(-1));

test('delete paper account with open cycle removes bots, history and related rows only for its owner',()=>{
  const db=openDatabase(':memory:');
  try{
    const a=newAccount('delete-me','owner','Bybit paper','market',0);
    a.bots.push({id:'bot-open',currentCycleId:'cycle-open'});
    a.cycles.push({id:'cycle-open',status:'OPEN'});
    a.snapshots=points(3);
    const other=newAccount('keep-me','other','Other','market',0);
    insertAccount(db,a);insertAccount(db,other);
    db.prepare('INSERT INTO commands VALUES(?,?,?)').run(a.id,'key',Date.now());
    assert.throws(()=>deleteAccount(db,a.id,'other',a.name),/Счёт не найден/);
    assert.throws(()=>deleteAccount(db,a.id,'owner','wrong'),/Название/);
    assert.equal(readAccount(db,a.id).cycles[0].status,'OPEN');
    deleteAccount(db,a.id,'owner',a.name);
    assert.throws(()=>readAccount(db,a.id),/Счёт не найден/);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM commands WHERE account_id=?').get(a.id).n,0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM account_snapshots WHERE account_id=?').get(a.id).n,0);
    assert.equal(readAccount(db,other.id).name,'Other');
  }finally{db.close();}
});

test('delete exchange removes all owner Bybit accounts including open bots, preserving other users and exchanges',()=>{
  const db=openDatabase(':memory:');
  try{
    const first=newAccount('first','owner','First','market',0,'bybit');
    const second=newAccount('second','owner','Second','market',0,'bybit');
    const foreign=newAccount('foreign','other','Foreign','market',0,'bybit');
    const otherExchange=newAccount('other-exchange','owner','Other exchange','market',0,'okx');
    first.bots.push({id:'running-bot',currentCycleId:'running-cycle'});
    first.cycles.push({id:'running-cycle',status:'OPEN'});
    for(const a of [first,second,foreign,otherExchange]){
      a.snapshots=points(3);
      insertAccount(db,a);
      db.prepare('INSERT INTO commands VALUES(?,?,?)').run(a.id,'key',Date.now());
    }
    assert.equal(deleteExchangeAccounts(db,'owner','bybit'),2);
    for(const id of [first.id,second.id]){
      assert.equal(db.prepare('SELECT COUNT(*) n FROM accounts WHERE id=?').get(id).n,0);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM commands WHERE account_id=?').get(id).n,0);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM account_snapshots WHERE account_id=?').get(id).n,0);
    }
    for(const id of [foreign.id,otherExchange.id]){
      assert.equal(db.prepare('SELECT COUNT(*) n FROM accounts WHERE id=?').get(id).n,1);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM commands WHERE account_id=?').get(id).n,1);
      assert.equal(readAccount(db,id).snapshots.length,3);
    }
  }finally{db.close();}
});

test('maintenance preview and apply support legacy databases without migrating them',()=>{
  const db=new DatabaseSync(':memory:');
  try{
    db.exec('CREATE TABLE accounts(id TEXT PRIMARY KEY, position INTEGER NOT NULL, state TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0)');
    const a=newAccount('legacy','owner','Source','market',0);a.snapshots=points(500);
    const b=createBot(a,{...DEFAULT_CONFIG,stages:{RSI_SHORT:true}},0);command(a,b.id,'start',{},0);
    db.prepare('INSERT INTO accounts VALUES(?,?,?,0)').run(a.id,1,JSON.stringify(a));
    const opts={ownerId:'owner',sourceIds:[a.id]};
    const before=db.prepare('SELECT state FROM accounts').get().state;
    assert.equal(createForkTestAccounts(db,opts)[0].status,'planned');
    assert.equal(db.prepare('SELECT state FROM accounts').get().state,before);
    assert.equal(createForkTestAccounts(db,{...opts,apply:true})[0].status,'created');
    assert.deepEqual(readAccount(db,a.id).snapshots,a.snapshots);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='account_snapshots'").get().n,0);
  }finally{db.close();}
});

test('legacy database migration preserves full history and makes trading state compact, including after reopen',()=>{
  const dir=mkdtempSync(join(tmpdir(),'vitrade-snapshots-')),path=join(dir,'legacy.sqlite');
  let db;
  try{
    const a=newAccount('a','owner','History','market',0);a.snapshots=points(17280);
    const legacy=new DatabaseSync(path);
    legacy.exec('CREATE TABLE accounts(id TEXT PRIMARY KEY, position INTEGER NOT NULL, state TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0)');
    legacy.prepare('INSERT INTO accounts VALUES(?,?,?,?)').run(a.id,1,JSON.stringify(a),9);legacy.close();
    db=openDatabase(path);
    assert.equal(stored(db,a.id).snapshots.length,1,'hot account state must not contain the full chart');
    assert.deepEqual(readAccount(db,a.id),a);
    assert.deepEqual(listAccounts(db),[a]);
    assert.deepEqual(readAccount(db,a.id,{snapshots:false}).snapshots,a.snapshots.slice(-1));
    assert.equal(db.prepare('SELECT revision FROM accounts').get().revision,9);
    db.close();db=openDatabase(path);
    assert.deepEqual(readAccount(db,a.id),a,'reopening must not duplicate or replace chart points');
  }finally{db?.close();rmSync(dir,{recursive:true,force:true});}
});

test('inserts, command edits and failed transactions preserve chart data',()=>{
  const db=openDatabase(':memory:');
  try{
    const a=newAccount('a','owner','Chart','market',0);a.snapshots=points(500);
    insertAccount(db,a);
    assert.equal(stored(db,a.id).snapshots.length,1);
    mutateAccount(db,a.id,x=>{x.name='Renamed';});
    assert.deepEqual(readAccount(db,a.id).snapshots,a.snapshots);
    const before=readAccount(db,a.id);
    assert.throws(()=>transaction(db,()=>{tickAccounts(db,3000000);throw Error('rollback');}),/rollback/);
    assert.deepEqual(readAccount(db,a.id),before);
  }finally{db.close();}
});

test('runner snapshot retention and financial results match the unchanged in-memory engine',()=>{
  const db=openDatabase(':memory:');
  try{
    const a=newAccount('a','owner','Trading','market',0);a.snapshots=points(17280);
    const now=a.snapshots.at(-1).at+5000;
    const b=createBot(a,{...DEFAULT_CONFIG,mode:'manual',symbol:'XUSDT',fork:{enabled:false}},now);
    command(a,b.id,'start',{},now);
    insertAccount(db,a);
    const q={XUSDT:{symbol:'XUSDT',mark:'100',bid:'100',ask:'100',source:'market',at:now}};
    setValue(db,'market:quotes',q);
    const expected=structuredClone(a);expected.walletBlocked=false;advance(expected,q,now);tickAccounts(db,now);
    const clean=x=>JSON.parse(JSON.stringify({...x,cycles:x.cycles.map(({id,...c})=>c),bots:x.bots.map(({currentCycleId,...b})=>b),events:x.events.map(({id,cycleId,...e})=>e),fills:x.fills.map(({id,cycleId,...f})=>f)}));
    assert.deepEqual(clean(readAccount(db,a.id)),clean(expected));
    assert.equal(stored(db,a.id).snapshots.length,1);
    assert.deepEqual(readAccount(db,a.id,{snapshots:'chart'}).snapshots,thin(expected.snapshots));
  }finally{db.close();}
});

test('chart sampling matches existing UI for small, uneven, and full histories and refreshes after append',()=>{
  const db=openDatabase(':memory:');
  try{
    for(const n of [1,239,240,241,246,479,480,1000,17280]){
      const a=newAccount(String(n),'owner','Chart','market',0);a.snapshots=points(n);insertAccount(db,a);
      assert.deepEqual(readAccount(db,a.id,{snapshots:'chart'}).snapshots,thin(a.snapshots));
    }
    tickAccounts(db,100000000);
    for(const a of listAccounts(db))assert.deepEqual(readAccount(db,a.id,{snapshots:'chart'}).snapshots,thin(a.snapshots));
  }finally{db.close();}
});
