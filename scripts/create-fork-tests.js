// Explicit maintenance command; never runs as part of server startup.
// Preview: node scripts/create-fork-tests.js --owner ID --sources ID1,ID2
// Apply the reviewed batch with a persistent SQLite backup: append --apply.
import {randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {resolve, dirname} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {DatabaseSync, backup} from 'node:sqlite';
import {insertAccount, listAccounts, transaction} from '../server/db.js';
import {newAccount, createBot, command, LIMITS} from '../server/engine/engine.js';

export function createForkTestAccounts(db, {ownerId, sourceIds, apply = false, now = Date.now()}) {
  if (typeof ownerId !== 'string' || !ownerId || !Array.isArray(sourceIds) || !sourceIds.length
    || sourceIds.length > LIMITS.accounts || sourceIds.some(id => typeof id !== 'string' || !id)
    || new Set(sourceIds).size !== sourceIds.length) throw Error('Укажите владельца и уникальные исходные счета');
  const run = () => {
    const owned = listAccounts(db).filter(a => a.ownerId === ownerId);
    const batch = sourceIds.map(id => {
      const source = owned.find(a => a.id === id);
      if (!source || source.archived || source.forkTestSourceId || source.source !== 'market' || source.exchange !== 'bybit') {
        throw Error(`Недоступный исходный paper-счёт: ${id}`);
      }
      const existing = owned.filter(a => a.forkTestSourceId === id);
      if (existing.length > 1 || existing[0]?.archived) throw Error(`Проверьте существующую тестовую копию: ${source.name}`);
      if (existing.length) return {source, copy:existing[0], status:'existing'};
      const name = `Вилка · ${source.name}`.slice(0,64);
      if (owned.some(a => a.name === name)) throw Error(`Название уже занято: ${name}`);
      const bots = source.bots.filter(b => !b.forkParentId && b.enabled);
      if (!bots.length) throw Error(`Нет работающих основных ботов: ${source.name}`);
      const copy = newAccount(randomUUID(), ownerId, name, source.source, now, source.exchange, source.initial);
      copy.forkTestSourceId = source.id;
      for (const original of bots) {
        const config = structuredClone(original.config);
        config.fork = {...config.fork, enabled:true};
        const bot = createBot(copy, config, now);
        bot.forkTestSourceBotId = original.id;
        command(copy, bot.id, 'start', {}, now);
      }
      return {source, copy, status:apply ? 'created' : 'planned'};
    });
    const added = batch.filter(row => row.status !== 'existing');
    if (new Set(batch.map(row=>row.copy.name)).size !== batch.length) throw Error('Совпадают названия тестовых копий');
    if (owned.filter(a => !a.archived).length + added.length > LIMITS.accounts) throw Error(`Превышен лимит ${LIMITS.accounts} активных счетов`);
    if (apply) for (const {copy} of added) insertAccount(db, copy);
    return batch.map(({source,copy,status}) => ({status,id:copy.id,sourceId:source.id,name:copy.name,initial:copy.initial,
      bots:copy.bots.length,running:copy.bots.filter(b=>b.enabled).length,forkEnabled:copy.bots.filter(b=>b.config.fork?.enabled).length}));
  };
  // Plan and insert under one lock: no duplicates or partial batches if retried/concurrent.
  return apply ? transaction(db, run) : run();
}

async function main() {
  const args = process.argv.slice(2);
  const value = flag => args[args.indexOf(flag) + 1];
  if (!args.includes('--owner') || !args.includes('--sources')) throw Error('Usage: --owner ID --sources ID1,ID2 [--apply]');
  const apply = args.includes('--apply');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const dbPath = process.env.VITRADE_DB || resolve(root,'data','vitrade.sqlite');
  if (!existsSync(dbPath)) throw Error('Existing database not found');
  const db = new DatabaseSync(dbPath,{readOnly:!apply});
  try {
    db.exec('PRAGMA busy_timeout=10000');
    const options = {ownerId:value('--owner'),sourceIds:value('--sources').split(',')};
    const preview = createForkTestAccounts(db,options);
    if (apply && preview.some(row=>row.status === 'planned')) {
      const backupPath = `${dbPath}.pre-fork-tests-${Date.now()}.sqlite`;
      await backup(db,backupPath);
      console.log(`BACKUP ${backupPath}`);
    }
    const rows = apply ? createForkTestAccounts(db,{...options,apply:true}) : preview;
    for (const row of rows) console.log(JSON.stringify(row));
    console.log(JSON.stringify({mode:apply?'apply':'dry-run',accounts:rows.length,bots:rows.reduce((n,r)=>n+r.bots,0),
      running:rows.reduce((n,r)=>n+r.running,0),forkEnabled:rows.reduce((n,r)=>n+r.forkEnabled,0)}));
  } finally {db.close();}
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error=>{console.error(error.message);process.exitCode=1;});
}
