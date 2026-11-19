import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createApi} from './http.js';
import {openDatabase,insertAccount,readAccount} from './db.js';
import {newAccount,createBot,DEFAULT_CONFIG} from './engine/engine.js';
import * as auth from './auth.js';

test('fork settings and preview require ownership; preview is read-only',async()=>{
  const db=openDatabase(':memory:'); auth.migrateAuth(db);
  const u=auth.register(db,{email:'fork@example.test',name:'Test',password:'test12345'});
  const v=auth.register(db,{email:'other@example.test',name:'Other',password:'test12345'});
  const a=newAccount('account',u,'test','market',0);
  const b=createBot(a,{...DEFAULT_CONFIG,stages:{RSI_SHORT:true}},0); insertAccount(db,a);
  const server=createApi({db,fetcher:()=>{throw Error('offline test');},webRoot:process.cwd(),port:0});
  const meta={agent:'test',ip:'127.0.0.1'};
  const tok=auth.createSession(db,u,meta),other=auth.createSession(db,v,meta);
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const base=`http://127.0.0.1:${server.address().port}`;
  const call=(path,data,token=tok)=>fetch(base+path,{method:'POST',headers:{'x-vitrade':'1','content-type':'application/json',cookie:token?`${auth.COOKIE}=${token}`:''},body:JSON.stringify(data)});
  const path=`/api/accounts/${a.id}/bots/${b.id}`;
  try {
    assert.equal((await call(`${path}/fork-preview`,{},'')).status,401);
    assert.equal((await call(`${path}/fork-preview`,{},other)).status,404);
    assert.equal((await call(`${path}/commands`,{action:'fork-settings',payload:{enabled:false}},other)).status,404);
    const initial=JSON.stringify(readAccount(db,a.id));
    const preview=await call(`${path}/fork-preview`,{settings:{rapidPct:'25'}});
    assert.equal(preview.status,200); assert.equal((await preview.json()).ok,false);
    assert.equal(JSON.stringify(readAccount(db,a.id)),initial);
    assert.equal((await call(`${path}/commands`,{action:'fork-settings',payload:{enabled:false,rapidPct:'25',stepPct:'6'}})).status,200);
    assert.equal(readAccount(db,a.id).bots[0].config.fork.rapidPct,'25');
    assert.equal(readAccount(db,a.id).bots[0].config.fork.enabled,false);
    assert.equal((await call(`${path}/commands`,{action:'fork-settings',payload:{rapidPct:'NaN'}})).status,400);
  } finally {server.closeAllConnections();await new Promise(r=>server.close(r));db.close();}
});
