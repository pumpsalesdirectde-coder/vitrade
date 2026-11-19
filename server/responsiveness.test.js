import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as immediate} from 'node:timers/promises';
import {openDatabase,insertAccount,mutateAccount,readAccount,transaction} from './db.js';
import {newAccount} from './engine/engine.js';
import {readSnapshots,clearSnapshotCache} from './snapshots.js';
import * as runner from './runner.js';
import * as http from './http.js';
import {spawnSync} from 'node:child_process';
import * as auth from './auth.js';

test('funding lookup preserves settlement boundaries and avoids unrelated history scans',()=>{
  assert.equal(typeof runner.pendingFunding,'function');
  let reads=0;
  const cycles=Array.from({length:1500},(_,i)=>({
    get symbol(){reads++;return `S${i}USDT`;},openedAt:10,closedAt:i%2?30:null,
  }));
  const due=Array.from({length:5600},(_,i)=>({symbol:`Z${i}USDT`,at:20}));
  due.push({symbol:'S0USDT',at:10},{symbol:'S0USDT',at:11},{symbol:'S1USDT',at:30},{symbol:'S1USDT',at:31});
  const funding=Array.from({length:1700},(_,i)=>({symbol:`Z${i}USDT`,at:20}));
  assert.deepEqual(runner.pendingFunding(due,funding,[{cycles}]),[
    {symbol:'S0USDT',at:11},{symbol:'S1USDT',at:30},
  ]);
  assert(reads<15000,`unrelated history was scanned ${reads} times`);
});

test('dashboard yields before completion and rechecks deleted/transferred accounts',async()=>{
  assert.equal(typeof http.dashboardAccounts,'function');
  const db=openDatabase(':memory:');
  try{
    for(let i=0;i<5;i++)insertAccount(db,newAccount(`a${i}`,'owner',`Account ${i}`,'market',0));
    let done=false;
    const run=http.dashboardAccounts(db,'owner',{}).then(value=>{done=true;return value;});
    await immediate();
    assert.equal(done,false,'the dashboard must yield before processing every account');
    mutateAccount(db,'a0',a=>{a.ownerId='someone-else';});
    db.prepare('DELETE FROM accounts WHERE id=?').run('a3');
    mutateAccount(db,'a4',a=>{a.ownerId='someone-else';});
    const result=await run;
    assert.deepEqual(result.map(a=>a.id),['a1','a2']);
    assert.equal(result[0].equity,'10000');
    assert.equal(db.isTransaction,false);
  }finally{db.close();}
});

test('chart cache keeps retained heap below 32 MiB for eighteen full accounts',()=>{
  const result=spawnSync(process.execPath,['--expose-gc','--input-type=module','-e',`
    import {openDatabase,insertAccount} from './server/db.js';
    import {newAccount} from './server/engine/engine.js';
    import {readSnapshots} from './server/snapshots.js';
    const db=openDatabase(':memory:');
    for(let n=0;n<18;n++){
      const a=newAccount(String(n),'owner','History','market',0);
      a.snapshots=Array.from({length:17280},(_,i)=>({at:i*5000,equity:String(10000+i)}));
      insertAccount(db,a);
    }
    global.gc();const before=process.memoryUsage().heapUsed;
    for(let n=0;n<18;n++)readSnapshots(db,String(n),'chart');
    global.gc();console.log(process.memoryUsage().heapUsed-before);db.close();
  `],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  assert(Number(result.stdout)<32*1024*1024,`chart cache retains ${result.stdout.trim()} bytes`);
});

test('authenticated dashboard serves a concurrent real HTTP health request before completing',async()=>{
  const db=openDatabase(':memory:');auth.migrateAuth(db);
  const user=auth.register(db,{email:'health@example.test',name:'Health',password:'test12345'});
  for(let n=0;n<18;n++){
    const a=newAccount(String(n),user,'History','market',0);
    a.snapshots=Array.from({length:17280},(_,i)=>({at:i*5000,equity:String(10000+i)}));
    insertAccount(db,a);
  }
  const server=http.createApi({db,fetcher:()=>{throw Error('offline');},webRoot:process.cwd(),port:0});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  const token=auth.createSession(db,user,{agent:'test',ip:'127.0.0.1'});
  let health,completed=false,healthBeforeState=false;
  server.on('request',req=>{
    if(req.url==='/api/state')health=fetch(base+'/api/health').then(async r=>{
      assert.equal(r.status,200);assert.equal((await r.json()).ok,true);healthBeforeState=!completed;
    });
  });
  try{
    await fetch(base+'/api/health').then(r=>r.json());
    const response=await fetch(base+'/api/state',{headers:{cookie:`${auth.COOKIE}=${token}`}});
    const state=await response.json();completed=true;
    await health;
    assert.equal(response.status,200);assert.equal(state.accounts.length,18);
    assert.equal(healthBeforeState,true,'health must not wait behind the complete dashboard');
  }finally{server.closeAllConnections();await new Promise(r=>server.close(r));db.close();}
});

test('warm chart refresh uses less CPU than rebuilding full histories',()=>{
  const db=openDatabase(':memory:');
  const ids=Array.from({length:8},(_,i)=>`a${i}`);
  const thin=xs=>Array.from({length:240},(_,i)=>xs[Math.floor(i*(xs.length/240))]).concat(xs.at(-1));
  try{
    for(const id of ids){
      const a=newAccount(id,'owner','History','market',0);
      a.snapshots=Array.from({length:17280},(_,i)=>({at:i*5000,equity:String(10000+i)}));
      insertAccount(db,a);
    }
    const cpu=fn=>{const before=process.cpuUsage();fn();const after=process.cpuUsage(before);return after.user+after.system;};
    let cold=0,warm=0;
    for(let n=0;n<4;n++){
      clearSnapshotCache(db);
      cold+=cpu(()=>{for(const id of ids)readSnapshots(db,id,'chart');});
      for(const id of ids)mutateAccount(db,id,a=>{a.snapshots.push({at:(17280+n)*5000,equity:'9876'});});
      warm+=cpu(()=>{for(const id of ids)readSnapshots(db,id,'chart');});
    }
    assert(warm<cold*0.65,`warm refresh ${warm}us should be well below cold ${cold}us`);
    for(const id of ids)assert.deepEqual(readSnapshots(db,id,'chart'),thin(readAccount(db,id).snapshots));
    const before=readSnapshots(db,'a0','chart');
    assert.throws(()=>transaction(db,()=>{
      mutateAccount(db,'a0',a=>{a.snapshots.push({at:1e9,equity:'1'});});
      readSnapshots(db,'a0','chart');throw Error('rollback');
    }),/rollback/);
    assert.deepEqual(readSnapshots(db,'a0','chart'),before);
  }finally{db.close();}
});
