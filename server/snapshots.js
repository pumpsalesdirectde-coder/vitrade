// Equity history lives outside the account JSON rewritten on every trading pass.
// All writes run in the same SQLite transaction as the corresponding account update.
const MAX_POINTS = 17280;
const CHART_POINTS = 240;
const MAX_CACHED_ACCOUNTS = 32;
const charts = new WeakMap();
const samePoint = (a, b) => a?.at === b?.at && a?.equity === b?.equity;
const plain = rows => rows.map(({at, equity}) => ({at, equity}));
export const compactAccount = a => ({...a, snapshots: a.snapshots.slice(-1)});

export function migrateSnapshots(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS account_snapshots(
    seq INTEGER PRIMARY KEY, account_id TEXT NOT NULL, at INTEGER NOT NULL, equity TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS account_snapshots_account ON account_snapshots(account_id, seq);`);
  if (db.prepare("SELECT 1 FROM kv WHERE key='schema:accountSnapshots'").get()) return;
  const add = db.prepare('INSERT INTO account_snapshots(account_id,at,equity) VALUES(?,?,?)');
  for (const row of db.prepare('SELECT id,state FROM accounts').all()) {
    const a = JSON.parse(row.state);
    for (const point of a.snapshots) add.run(row.id, point.at, point.equity);
    db.prepare('UPDATE accounts SET state=? WHERE id=?').run(JSON.stringify(compactAccount(a)), row.id);
  }
  db.prepare("INSERT INTO kv(key,value) VALUES('schema:accountSnapshots','1')").run();
}

export function appendSnapshots(db, id, points) {
  const last = db.prepare('SELECT at,equity FROM account_snapshots WHERE account_id=? ORDER BY seq DESC LIMIT 1').get(id);
  let start = 0;
  if (last) {
    const i = points.findLastIndex(p => samePoint(p, last));
    if (i < 0) throw Error('История графика не соответствует состоянию счёта');
    start = i + 1;
  }
  if (start === points.length) return;
  const add = db.prepare('INSERT INTO account_snapshots(account_id,at,equity) VALUES(?,?,?)');
  for (const p of points.slice(start)) add.run(id, p.at, p.equity);
  db.prepare(`DELETE FROM account_snapshots WHERE account_id=? AND seq < (
    SELECT seq FROM account_snapshots WHERE account_id=? ORDER BY seq DESC LIMIT 1 OFFSET ?)`)
    .run(id, id, MAX_POINTS - 1);
}

export function readSnapshots(db, id, mode = true) {
  if (mode !== 'chart') return plain(db.prepare('SELECT at,equity FROM account_snapshots WHERE account_id=? ORDER BY seq').all(id));
  const last = db.prepare('SELECT seq FROM account_snapshots WHERE account_id=? ORDER BY seq DESC LIMIT 1').get(id)?.seq;
  let cache = charts.get(db);
  if (!cache) charts.set(db, cache = new Map());
  if (last === undefined) { cache.delete(id); return []; }
  const hit = cache.get(id);
  if (hit) { cache.delete(id); cache.set(id, hit); }
  if (hit?.last === last) return plain(hit.points);
  // A new equity point must not trigger a window-function scan of the entire history.
  // Retain only the on-disk window and fetch newly appended rows by the existing index.
  const first = db.prepare('SELECT seq FROM account_snapshots WHERE account_id=? ORDER BY seq LIMIT 1').get(id).seq;
  const incremental = hit && hit.last >= first && hit.last < last;
  const added = db.prepare('SELECT seq FROM account_snapshots WHERE account_id=? AND seq>? ORDER BY seq')
    .all(id, incremental ? hit.last : 0).map(p => p.seq);
  // Numeric IDs are much smaller than retaining SQLite row objects for every point.
  const seqs = incremental ? hit.seqs.filter(seq => seq >= first).concat(added) : added;
  const n = seqs.length;
  // Preserve the original JavaScript floating-point operation order as well as endpoints.
  const step = n / CHART_POINTS;
  const indices = n <= CHART_POINTS ? Array.from({length:n}, (_,i)=>i)
    : Array.from({length:CHART_POINTS}, (_,i)=>Math.floor(i*step)).concat(n-1);
  const sampled = indices.map(i => seqs[i]);
  const points = plain(db.prepare(`SELECT at,equity FROM account_snapshots WHERE seq IN (${sampled.map(()=>'?').join(',')}) ORDER BY seq`)
    .all(...sampled));
  cache.set(id, {last, seqs, points});
  while (cache.size > MAX_CACHED_ACCOUNTS) cache.delete(cache.keys().next().value);
  return plain(points);
}

export function clearSnapshotCache(db) { charts.delete(db); }
