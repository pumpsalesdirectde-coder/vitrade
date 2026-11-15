// Equity history lives outside the account JSON rewritten on every trading pass.
// All writes run in the same SQLite transaction as the corresponding account update.
const MAX_POINTS = 17280;
const CHART_POINTS = 240;
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
  if (last === undefined) return [];
  let cache = charts.get(db);
  if (!cache) charts.set(db, cache = new Map());
  const hit = cache.get(id);
  if (hit?.last === last) return plain(hit.points);
  const n = db.prepare('SELECT COUNT(*) n FROM account_snapshots WHERE account_id=?').get(id).n;
  // Preserve the original JavaScript floating-point operation order as well as endpoints.
  const step = n / CHART_POINTS;
  const indices = n <= CHART_POINTS ? Array.from({length:n}, (_,i)=>i)
    : Array.from({length:CHART_POINTS}, (_,i)=>Math.floor(i*step)).concat(n-1);
  const points = plain(db.prepare(`WITH ranked AS (
    SELECT at,equity,ROW_NUMBER() OVER (ORDER BY seq)-1 AS i FROM account_snapshots WHERE account_id=?
  ) SELECT at,equity FROM ranked WHERE i IN (${indices.map(()=>'?').join(',')}) ORDER BY i`)
    .all(id, ...indices));
  cache.set(id, {last, points});
  return plain(points);
}

export function clearSnapshotCache(db) { charts.delete(db); }
