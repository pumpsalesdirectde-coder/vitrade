import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase, insertAccount, listAccounts} from './db.js';
import {newAccount, createBot, command, DEFAULT_CONFIG, LIMITS} from './engine/engine.js';
import {createForkTestAccounts} from '../scripts/create-fork-tests.js';

function fixture(count = 8) {
  const db = openDatabase(':memory:');
  const sourceIds = [];
  for (let i = 0; i < count; i++) {
    const a = newAccount(`source-${i}`, 'owner', `Strategy ${i}`, 'market', 10);
    for (let j = 0; j < 10; j++) {
      const b = createBot(a, {...DEFAULT_CONFIG, stages: {RSI_SHORT:true}, name: `Bot ${j}`, budget: '100', fork: {...DEFAULT_CONFIG.fork, enabled: false, rapidPct: '27'}}, 10);
      command(a, b.id, 'start', {}, 10);
    }
    if (i === 0) createBot(a, {...DEFAULT_CONFIG, stages: {RSI_SHORT:true}, name: 'Stopped diagnostic'}, 10);
    a.cash = '8300'; a.fills.push({id: 'old-fill'}); a.forks = [{id:'old-pair',status:'CLOSED'}];
    sourceIds.push(a.id); insertAccount(db, a);
  }
  return {db, sourceIds};
}

test('dry run is read-only; eight clean copies retain configs and start 80 fork-enabled bots', () => {
  const {db, sourceIds} = fixture();
  try {
    const before = listAccounts(db);
    const options = {ownerId:'owner', sourceIds, now:100};
    assert.equal(createForkTestAccounts(db, options).length, 8);
    assert.deepEqual(listAccounts(db), before);
    const result = createForkTestAccounts(db, {...options, apply:true});
    assert.equal(result.length, 8); assert.ok(LIMITS.accounts >= 16);
    const after = listAccounts(db);
    assert.deepEqual(after.slice(0, 8), before);
    for (let i = 0; i < 8; i++) {
      const copy = after[i + 8];
      assert.equal(copy.name, `Вилка · Strategy ${i}`);
      assert.equal(copy.ownerId, 'owner'); assert.equal(copy.initial, '10000'); assert.equal(copy.cash, '10000');
      assert.deepEqual(copy.cycles, []); assert.deepEqual(copy.fills, []); assert.equal(copy.forks, undefined);
      assert.equal(copy.bots.length, 10); assert.equal(copy.forkTestSourceId, sourceIds[i]);
      for (let j = 0; j < 10; j++) {
        const b = copy.bots[j]; const original = before[i].bots[j];
        assert.notEqual(b.id, original.id); assert.equal(b.currentCycleId, null); assert.equal(b.enabled, true);
        assert.deepEqual(b.config, {...original.config, fork:{...original.config.fork, enabled:true}});
        assert.equal(b.activatedAt, 100);
      }
    }
    const snapshot = listAccounts(db);
    const again = createForkTestAccounts(db, {...options, apply:true});
    assert.ok(again.every(r => r.status === 'existing'));
    assert.deepEqual(listAccounts(db), snapshot);
  } finally {db.close();}
});

test('rejects foreign, missing, archived and repeated source accounts without partial writes', () => {
  const {db, sourceIds} = fixture(2);
  try {
    const before = listAccounts(db);
    for (const opts of [
      {ownerId:'other',sourceIds}, {ownerId:'owner',sourceIds:['missing']},
      {ownerId:'owner',sourceIds:[sourceIds[0],sourceIds[0]]}, {ownerId:'owner',sourceIds:[]},
    ]) assert.throws(() => createForkTestAccounts(db, {...opts,apply:true}));
    assert.deepEqual(listAccounts(db), before);
    const archived = newAccount('archived','owner','Archived','market',1); archived.archived = true; insertAccount(db,archived);
    assert.throws(() => createForkTestAccounts(db,{ownerId:'owner',sourceIds:[sourceIds[0],'archived'],apply:true}));
    assert.equal(listAccounts(db).length,3);
  } finally {db.close();}
});

test('account cap and bot budget failure leave no partial batch', () => {
  const {db, sourceIds} = fixture(1);
  try {
    for(let i=1;i<LIMITS.accounts;i++) insertAccount(db,newAccount(`extra-${i}`,'owner',`Extra ${i}`,'market',1));
    assert.throws(()=>createForkTestAccounts(db,{ownerId:'owner',sourceIds,apply:true}),/лимит/i);
    assert.equal(listAccounts(db).length,LIMITS.accounts);
  } finally {db.close();}
  const other = fixture(2);
  try {
    const row = listAccounts(other.db)[1]; row.initial='1';
    other.db.prepare('UPDATE accounts SET state=? WHERE id=?').run(JSON.stringify(row),row.id);
    assert.throws(()=>createForkTestAccounts(other.db,{ownerId:'owner',sourceIds:other.sourceIds,apply:true}),/средств/i);
    assert.equal(listAccounts(other.db).length,2);
  } finally {other.db.close();}
});

test('rejects test copies as sources and ambiguous target names', () => {
  const {db,sourceIds} = fixture(1);
  try {
    createForkTestAccounts(db,{ownerId:'owner',sourceIds,apply:true});
    const copy = listAccounts(db).find(a=>a.forkTestSourceId);
    assert.throws(()=>createForkTestAccounts(db,{ownerId:'owner',sourceIds:[copy.id],apply:true}));
  } finally {db.close();}
  const other=fixture(1);
  try {
    insertAccount(other.db,newAccount('collision','owner','Вилка · Strategy 0','market',1));
    assert.throws(()=>createForkTestAccounts(other.db,{ownerId:'owner',sourceIds:other.sourceIds,apply:true}),/назван/i);
    assert.equal(listAccounts(other.db).length,2);
  } finally {other.db.close();}
});
