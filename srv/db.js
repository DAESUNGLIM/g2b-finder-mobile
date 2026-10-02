/**
 * 모바일 검색용 — PC 의 src/db.js 대신 쓰는 것.
 * search.js · coverage.js · clsfc.js 가 쓰는 node:sqlite 모양(prepare().get/all/run, exec)을
 * 휴대폰 브라우저의 SQLite(WebAssembly, OPFS 에 저장)로 흉내 낸다. 그래서 검색 코드는 PC 와 같은 파일을 쓴다.
 */

let raw = null; // sqlite3.oo1 DB (worker.js 가 열어서 꽂아 준다)

export function setDb(d) {
  raw = d;
}
export const rawDb = () => raw;

// node:sqlite 는 undefined 를 못 받고 boolean 은 0/1 로 넣는다 — 같은 결과가 되게 맞춘다
const val = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
function bindOf(args) {
  if (!args.length) return undefined;
  if (args.length === 1 && args[0] && typeof args[0] === 'object' && !Array.isArray(args[0]) && !(args[0] instanceof Uint8Array)) {
    // 이름 붙은 값 { a: 1 } → { $a: 1, :a: 1, @a: 1 } (SQL 에 어느 표시를 써도 되게)
    const o = {};
    for (const [k, v] of Object.entries(args[0])) for (const p of ['$', ':', '@']) o[p + k] = val(v);
    return o;
  }
  return args.map(val);
}

class Statement {
  constructor(sql) {
    this.sql = sql;
  }
  all(...args) {
    return raw.selectObjects(this.sql, bindOf(args));
  }
  get(...args) {
    return raw.selectObject(this.sql, bindOf(args));
  }
  run(...args) {
    raw.exec({ sql: this.sql, bind: bindOf(args) });
    return { changes: raw.changes(), lastInsertRowid: Number(raw.selectValue('SELECT last_insert_rowid()')) };
  }
}

export const db = {
  prepare: (sql) => new Statement(sql),
  exec: (sql) => raw.exec(sql),
};

export function transaction(fn) {
  raw.exec('BEGIN');
  try {
    const out = fn();
    raw.exec('COMMIT');
    return out;
  } catch (err) {
    raw.exec('ROLLBACK');
    throw err;
  }
}

export function getConfig(key, fallback = null) {
  const row = raw.selectObject('SELECT value FROM settings WHERE key = ?', [key]);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value);
  } catch {
    return row.value;
  }
}

export function setConfig(key, value) {
  raw.exec({ sql: 'INSERT OR REPLACE INTO settings(key, value) VALUES(?, ?)', bind: [key, JSON.stringify(value)] });
}

export function today() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

export function nowIso() {
  return new Date().toISOString();
}

// 휴대폰은 API 를 부르지 않는다
export function usageToday() {
  return { day: today(), total: 0, rows: [], services: [], shopLeft: 0 };
}
