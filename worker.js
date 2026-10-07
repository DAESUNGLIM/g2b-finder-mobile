/**
 * 모바일 검색용 — 휴대폰 브라우저 안에서 PC 서버 대신 도는 것 (Web Worker).
 *
 *   1. 배포 폴더(OneDrive 공유 링크)에서 모바일용 기본자료(mbase-*.db.gz, 원본 JSON 을 뺀 DB)를 받아
 *      휴대폰 저장소(OPFS)에 둔다. 다음부터는 변경분(patch-*.json.gz, PC 검색용과 같은 것)만 더한다.
 *   2. 화면(app.js)이 /api/... 로 묻는 것을 PC 와 같은 검색 코드(srv/search.js 등, PC 의 src 를 그대로 복사)로 답한다.
 *      그래서 관리자 PC 가 꺼져 있어도 된다.
 *
 * 화면과는 mobile.js 가 postMessage 로 주고받는다: { id, method, url, body } → { id, status, body, type }
 */

import sqlite3InitModule from './sqlite/index.mjs';
import { setDb, rawDb, db, getConfig, setConfig, nowIso, transaction } from './srv/db.js';

const POOL = 'g2b-finder';
const SLOTS = ['/g2b-a.db', '/g2b-b.db'];
const BADGER_APP = '5cbed6ac-a083-4e14-b191-b4ba07653de2';
const CHECK_MS = 5 * 60 * 1000;

let sqlite3, pool, store, cov, clsfc, spec, conf;
let state = {}; // 받은 자료 상태 (OPFS state.json)
const status = { lastCheck: null, lastApplied: null, publishedAt: null, error: null, restarting: false, phase: 'start', progress: null };
let overviewCache = null;

/* ── 상태 파일 (OPFS) ── */

async function opfsRoot() {
  return navigator.storage.getDirectory();
}
async function readState() {
  try {
    const fh = await (await opfsRoot()).getFileHandle('state.json');
    return JSON.parse(await (await fh.getFile()).text());
  } catch {
    return {};
  }
}
async function writeState(patch) {
  state = { ...state, ...patch };
  const fh = await (await opfsRoot()).getFileHandle('state.json', { create: true });
  const w = await fh.createWritable();
  await w.write(JSON.stringify(state));
  await w.close();
}

const post = (msg) => self.postMessage(msg);
function setPhase(phase, progress = null) {
  status.phase = phase;
  status.progress = progress;
  post({ type: 'status', status: { ...status } });
}

/* ── OneDrive 배포 폴더 (src/feed-net.js 와 같은 방법) ── */

function shareToken(link) {
  const bytes = new TextEncoder().encode(link);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return 'u!' + btoa(bin).replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-');
}

let badger = { token: '', until: 0 };
async function badgerToken() {
  if (badger.token && Date.now() < badger.until) return badger.token;
  const r = await fetch('https://api-badgerp.svc.ms/v1.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', AppId: BADGER_APP },
    body: JSON.stringify({ appId: BADGER_APP }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.token) throw new Error(`OneDrive 공유 폴더를 열 권한을 받지 못했습니다 (${r.status}).`);
  const exp = Date.parse(j.expiryTimeUtc || '') || Date.now() + 30 * 60000;
  badger = { token: j.token, until: exp - 5 * 60000 };
  return badger.token;
}

async function getJson(url) {
  const r = await fetch(url, { headers: { Accept: 'application/json', Authorization: 'Badger ' + (await badgerToken()), Prefer: 'autoredeem' } });
  if (r.status === 401) badger = { token: '', until: 0 };
  if (!r.ok) throw new Error(`배포 폴더를 열지 못했습니다 (${r.status}). 링크가 "링크가 있는 모든 사용자" 공유인지 확인해 주세요.`);
  return r.json();
}

let listCache = { at: 0, map: new Map() };
async function listFiles(fresh = false) {
  if (!fresh && Date.now() - listCache.at < 20000) return listCache.map;
  const map = new Map();
  let url = `https://my.microsoftpersonalcontent.com/_api/v2.0/shares/${shareToken(state.feed)}/driveitem/children?$top=1000&$select=name,size,file,@content.downloadUrl`;
  while (url) {
    const j = await getJson(url);
    for (const it of j.value || []) if (it['@content.downloadUrl']) map.set(it.name, it['@content.downloadUrl']);
    url = j['@odata.nextLink'] || '';
  }
  listCache = { at: Date.now(), map };
  return map;
}

// 시험할 때는 OneDrive 대신 같은 사이트의 폴더 주소(예: /feed/)를 넣을 수 있다
const isLocal = () => !/^https?:\/\//i.test(state.feed || '');

async function fileResponse(name) {
  if (isLocal()) {
    const r = await fetch(state.feed.replace(/\/?$/, '/') + encodeURIComponent(name), { cache: 'no-store' });
    if (!r.ok || !r.body) throw new Error(`${name} 을(를) 받지 못했습니다 (${r.status}).`);
    return r;
  }
  let map = await listFiles();
  if (!map.has(name)) map = await listFiles(true);
  const u = map.get(name);
  if (!u) throw new Error(`배포 폴더에 ${name} 이(가) 없습니다.`);
  const r = await fetch(u);
  if (!r.ok || !r.body) throw new Error(`${name} 을(를) 받지 못했습니다 (${r.status}).`);
  return r;
}

async function getManifest() {
  if (isLocal()) return (await fileResponse('manifest.json')).json();
  const map = await listFiles(true);
  const u = map.get('manifest.json');
  if (!u) throw new Error('배포 폴더에 manifest.json 이 없습니다. 관리자 PC 에서 배포를 켰는지 확인해 주세요.');
  const r = await fetch(u);
  if (!r.ok) throw new Error(`배포 목록을 받지 못했습니다 (${r.status}).`);
  return r.json();
}

/** 작은 .gz (변경분) → 풀어서 JSON */
async function fetchGzJson(name) {
  const r = await fileResponse(name);
  const text = await new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).text();
  return JSON.parse(text);
}

/* ── 기본자료 받기·바꾸기 ── */

function openSlot(slot) {
  const d = new pool.OpfsSAHPoolDb(slot);
  d.exec('PRAGMA cache_size = -24000'); // 약 24MB
  d.exec('PRAGMA temp_store = MEMORY');
  return d;
}

/** 관심목록·내 설정을 새 DB 로 옮긴다 (PC 검색용 boot.js 와 같이) */
function carryOver(from, to) {
  for (const t of ['bookmark', 'settings']) {
    let rows = [];
    try {
      rows = from.selectObjects(`SELECT * FROM ${t}`);
    } catch {
      continue;
    }
    if (!rows.length) continue;
    const cols = Object.keys(rows[0]);
    to.exec('BEGIN');
    try {
      for (const r of rows) to.exec({ sql: `INSERT OR REPLACE INTO ${t}(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`, bind: cols.map((c) => r[c]) });
      to.exec('COMMIT');
    } catch {
      to.exec('ROLLBACK');
    }
  }
}

async function installBase(m) {
  const mb = m.mbase;
  if (!mb) throw new Error('관리자 PC 가 아직 모바일용 자료를 만들지 않았습니다. 관리자 PC 에서 배포가 한 번 더 돌면 생깁니다 (몇 분).');
  const next = SLOTS.find((s) => s !== state.slot) || SLOTS[0];
  setPhase('download', { got: 0, total: mb.size, file: mb.file });
  const r = await fileResponse(mb.file);
  let got = 0;
  const counted = r.body.pipeThrough(
    new TransformStream({
      transform(chunk, ctl) {
        got += chunk.byteLength;
        if (got === chunk.byteLength || got % (1 << 20) < chunk.byteLength) setPhase('download', { got, total: mb.size, file: mb.file });
        ctl.enqueue(chunk);
      },
    })
  );
  const reader = counted.pipeThrough(new DecompressionStream('gzip')).getReader();
  try {
    pool.unlink(next);
  } catch {}
  await pool.importDb(next, async () => {
    const { done, value } = await reader.read();
    return done ? undefined : value;
  });
  setPhase('prepare');
  const fresh = openSlot(next);
  const old = rawDb();
  if (old) {
    carryOver(old, fresh);
    old.close();
  }
  setDb(fresh);
  if (state.slot && state.slot !== next) {
    try {
      pool.unlink(state.slot);
    } catch {}
  }
  await writeState({ slot: next, baseId: m.base.id, mbaseId: mb.id, applied: mb.seq, dataAt: mb.createdAt, baseAt: mb.createdAt });
  overviewCache = null;
}

/* ── 변경분 (src/feed.js 와 같은 방법) ── */

const PK = {
  order_item: ['dlvr_req_no', 'chg_ord', 'prdct_sno'],
  order_head: ['dlvr_req_no', 'chg_ord'],
  product: ['dataset', 'cntrct_no', 'cntrct_sno', 'prdct_idnt_no'],
  coverage: ['dataset', 'filter_key', 'day'],
  corp_api: ['bizno'],
  corp_fetch: ['term'], // 업체 단위로 등록품목을 받아 본 업체 (업체 실적 "전체 품목" 의 빠진 자료 확인)
  clsfc: ['kind', 'code'],
};

/**
 * 파일로 넣은 쇼핑몰 등록품목과 그 파일로 적은 "등록품목을 받아 본 업체" 는 휴대폰에 두지 않는다
 * (쇼핑몰 전체 등록 내역은 100만 줄 — PC 의 publish.js buildMobileBase 와 같은 규칙).
 */
function forPhone(t, row) {
  if (t === 'product') return !String(row.seen_run || '').startsWith('file:');
  if (t === 'corp_fetch') return row.term !== '*' && !/"file":/.test(String(row.result || ''));
  return true;
}

function applyPatch(p) {
  const d = rawDb();
  transaction(() => {
    for (const [t, { upsert = [], del = [] }] of Object.entries(p.tables || {})) {
      if (!PK[t]) continue;
      const delSql = `DELETE FROM ${t} WHERE ${PK[t].map((c) => `${c} IS ?`).join(' AND ')}`;
      for (const vals of del) d.exec({ sql: delSql, bind: vals });
      for (const row of upsert) {
        if (!forPhone(t, row)) continue;
        if ('raw' in row) row.raw = null; // 휴대폰에는 원본 JSON 을 두지 않는다
        const cols = Object.keys(row);
        d.exec({ sql: `INSERT OR REPLACE INTO ${t}(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`, bind: cols.map((c) => row[c]) });
      }
    }
    // 새로 생긴 업체의 소재지 (PC 의 corpinfo.refreshCorpInfo 가운데 원본 JSON 이 필요 없는 부분)
    d.exec(`INSERT OR IGNORE INTO corp_info(bizno, loc, src, updated_at)
              SELECT b, hdoffce, 'product', '${nowIso()}' FROM (
                SELECT REPLACE(corp_bizno, '-', '') b, hdoffce, MAX(rgst_date)
                  FROM product WHERE COALESCE(hdoffce, '') <> '' AND corp_bizno <> '' GROUP BY b)`);
    d.exec(`INSERT OR REPLACE INTO corp_info(bizno, loc, src, updated_at)
              SELECT bizno, loc, 'api', '${nowIso()}' FROM corp_api WHERE found = 1 AND COALESCE(loc, '') <> ''`);
  });
}

let checking = null;
/** 배포 폴더 확인 — 새 기본자료면 받아서 바꾸고, 아니면 변경분만 더한다 */
function checkFeed() {
  if (checking) return checking;
  if (!state.feed || !pool) return Promise.resolve(); // 아직 시작 전 (링크를 받기 전)
  checking = (async () => {
    try {
      const m = await getManifest();
      status.lastCheck = nowIso();
      status.publishedAt = m.publishedAt || null;
      reqLink = m.reqLink || '';
      const hadDb = Boolean(rawDb());
      if (!hadDb || !m.mbase || state.mbaseId !== m.mbase.id) {
        // 처음이거나 기본자료가 새로 만들어졌다
        if (!m.mbase && hadDb) {
          // 모바일용 기본자료가 아직 없으면 가진 것으로 계속 (변경분은 기본자료가 같을 때만)
        } else {
          await installBase(m);
          if (hadDb) post({ type: 'reload', why: '새 기본자료로 바꿨습니다.' });
        }
      }
      if (Array.isArray(m.myCorps)) setConfig('myCorps', m.myCorps);
      let applied = state.applied || 0;
      let n = 0;
      for (const p of m.patches || []) {
        if (p.to <= applied) continue;
        if (p.from > applied + 1 && state.mbaseId === m.mbase?.id) {
          // 중간 변경분이 지워졌다 — 기본자료부터 다시
          await installBase(m);
          post({ type: 'reload', why: '받지 못한 변경분이 있어 기본자료부터 다시 받았습니다.' });
          return;
        }
        setPhase('patch', { n: n + 1 });
        applyPatch(await fetchGzJson(p.file));
        applied = p.to;
        await writeState({ applied, dataAt: p.createdAt });
        n++;
      }
      if (n) {
        status.lastApplied = nowIso();
        overviewCache = null;
      }
      status.error = null;
      await flushRequests();
    } catch (err) {
      status.error = err.message;
      throw err;
    } finally {
      setPhase(rawDb() ? 'ready' : 'error');
      checking = null;
    }
  })();
  return checking;
}

/* ── 자료 요청 (src/request.js 와 같은 방법 — 관리자 PC 요청함에 쪽지를 올린다) ── */

let reqLink = '';
const keyOf = (r) => [r.dataset, r.from, r.to, r.dtil, r.corp || ''].join('|');

async function uploadShared(link, name, text) {
  const base = `https://my.microsoftpersonalcontent.com/_api/v2.0/shares/${shareToken(link)}/driveitem`;
  const s = await fetch(`${base}:/${encodeURIComponent(name)}:/oneDrive.createUploadSession`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Badger ' + (await badgerToken()), Prefer: 'autoredeem' },
    body: JSON.stringify({ item: { '@name.conflictBehavior': 'replace' } }),
  });
  if (s.status === 401) badger = { token: '', until: 0 };
  const sj = await s.json().catch(() => ({}));
  if (!s.ok || !sj.uploadUrl) throw new Error(`요청을 올리지 못했습니다 (${s.status}).`);
  const buf = new TextEncoder().encode(text);
  const r = await fetch(sj.uploadUrl, { method: 'PUT', headers: { 'Content-Range': `bytes 0-${buf.length - 1}/${buf.length}` }, body: buf });
  if (!r.ok) throw new Error(`요청을 올리지 못했습니다 (${r.status}).`);
}

async function askFor({ dataset, from, to, dtil, corp }) {
  const req = {
    v: 1,
    id: new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14) + Math.random().toString(16).slice(2, 8),
    at: new Date().toISOString(),
    who: '휴대폰',
    dataset: String(dataset || 'dlvrDtl'),
    from: String(from || ''),
    to: String(to || ''),
    dtil: String(dtil || ''),
  };
  if (req.dataset === 'corp') {
    req.corp = String(corp || '').trim().slice(0, 60);
    if (req.corp.length < 2) throw new Error('요청할 업체명을 두 글자 이상 넣어 주세요.');
  } else if (!/^[0-9]{8}$/.test(req.from) || !/^[0-9]{8}$/.test(req.to) || !req.dtil) {
    throw new Error('요청할 기간과 세부품명이 있어야 합니다.');
  }
  const sent = state.reqSent || [];
  const key = keyOf(req);
  if (sent.includes(key)) return { state: 'dup' };
  const pending = (state.reqPending || []).filter((p) => keyOf(p) !== key);
  pending.push(req);
  await writeState({ reqPending: pending.slice(-20) });
  const r = await flushRequests();
  return { state: r.sent > 0 ? 'sent' : 'queued', error: r.error };
}

async function flushRequests() {
  const pending = state.reqPending || [];
  if (!pending.length) return { sent: 0, error: null };
  if (!reqLink) return { sent: 0, error: '관리자 PC 에서 요청 받기를 아직 켜지 않았습니다.' };
  let sent = 0;
  let error = null;
  for (const req of pending) {
    try {
      await uploadShared(reqLink, `req-${req.id}.json`, JSON.stringify(req));
      await writeState({
        reqPending: (state.reqPending || []).filter((p) => p.id !== req.id),
        reqSent: [...(state.reqSent || []).filter((k) => k !== keyOf(req)), keyOf(req)].slice(-300),
      });
      sent++;
    } catch (err) {
      error = err.message;
      break;
    }
  }
  return { sent, error };
}

function feedStatus() {
  return {
    ...status,
    canAsk: Boolean(reqLink),
    pending: (state.reqPending || []).length,
    sent: (state.reqSent || []).length,
    baseId: state.baseId || null,
    baseAt: state.baseAt || null,
    applied: state.applied || 0,
    dataAt: state.dataAt || state.baseAt || null,
  };
}

/* ── /api 답하기 (src/routes/api.js 가운데 검색 전용이 쓰는 것) ── */

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function overview() {
  if (!overviewCache) overviewCache = store.overview();
  return overviewCache;
}

async function route(method, url, body) {
  const u = new URL(url, 'http://m/');
  const path = u.pathname.replace(/^\/api/, '') || '/';
  const q = Object.fromEntries(u.searchParams.entries());

  if (path === '/whoami') return { viewer: true, mobile: true };
  if (path === '/meta' && method === 'GET') {
    return {
      datasets: spec.DATASET_LIST,
      filterLabels: spec.FILTER_LABELS,
      settings: conf.publicSettings(),
      usage: { day: '', total: 0, rows: [], services: [], shopLeft: 0 },
      // 전체 요약은 수집·설정 탭(검색 전용에는 없음)에서만 쓴다 — 휴대폰에서 몇 초 걸려 계산하지 않는다
      overview: null,
      collecting: false,
      viewer: true,
      mobile: true,
      inbox: 0,
    };
  }
  if (path === '/feed/status' && method === 'GET') return feedStatus();
  if (path === '/feed/check' && method === 'POST') {
    await checkFeed().catch(() => {});
    return feedStatus();
  }
  if (path === '/ask' && method === 'POST') return askFor(body || {});
  if (path === '/settings' && method === 'GET') return conf.publicSettings();
  if (path === '/settings' && method === 'POST') {
    overviewCache = null;
    return conf.saveSettings(body || {});
  }
  if (path === '/usage' && method === 'GET') return { day: '', total: 0, rows: [], services: [], shopLeft: 0, limit: 0 };
  if (path === '/overview' && method === 'GET') return { ...overview(), coverage: cov.coverageSummary() };

  if (path === '/coverage' && method === 'GET') {
    const ds = spec.DATASETS[q.dataset || 'dlvrDtl'];
    if (!ds) throw new HttpError(400, '알 수 없는 데이터셋: ' + q.dataset);
    const from = String(q.from || '').replace(/[^0-9]/g, '');
    const to = String(q.to || '').replace(/[^0-9]/g, '');
    if (from.length !== 8 || to.length !== 8) throw new HttpError(400, 'from/to 를 YYYYMMDD 로 지정하세요.');
    const filters = {};
    if (q.dtil) filters.dtilPrdctClsfcNoNm = q.dtil;
    const key = cov.filterKey(ds, filters);
    const m = cov.missingDays(ds.id, from, to, cov.acceptKeys(key));
    return {
      dataset: ds.id,
      from: m.from,
      to: m.to,
      totalDays: m.total,
      missingDays: m.days.length,
      ranges: cov.toRanges(m.days, 31),
      estCalls: 0,
      filters,
      chunkDays: key ? 31 : 7,
      remainingCalls: 0,
      mock: false,
      collecting: false,
    };
  }

  if (path === '/products' && method === 'GET') return store.searchProducts(q);
  if (path === '/orders' && method === 'GET') return store.searchOrders(q);
  if (path === '/orders/history' && method === 'GET') return { rows: store.orderHistory(q.no, q.sno) };
  if (path === '/aggregate' && method === 'GET') return store.aggregateOrders(q);
  if (path === '/compare/pick' && method === 'GET') return store.comparePickList();
  if (path === '/compare' && method === 'GET') return store.compareItems(q.ids);

  if (path === '/perf/corps' && method === 'GET') return store.suggestCorps(q.term, q.limit);
  if (path === '/perf/fillplan' && method === 'GET') {
    const from = String(q.from || '').replace(/[^0-9]/g, '');
    const to = String(q.to || '').replace(/[^0-9]/g, '');
    if (from.length !== 8 || to.length !== 8) throw new HttpError(400, 'from/to 를 YYYYMMDD 로 지정하세요.');
    const biznos = String(q.biznos || '').split(',').map((b) => b.replace(/[^0-9]/g, '')).filter(Boolean);
    const years = String(q.years || '').split(',').filter((y) => /^\d{4}$/.test(y)).sort();
    const ranges = years.length
      ? years.map((y) => [from > y + '0101' ? from : y + '0101', to < y + '1231' ? to : y + '1231']).filter(([a, b]) => a <= b)
      : [[from, to]];
    const ds = spec.DATASETS.dlvrDtl;
    const dtils = store.corpDtils(biznos, from, to);
    const jobs = [];
    for (const d of dtils) {
      const filters = { dtilPrdctClsfcNoNm: d.dtil };
      const key = cov.filterKey(ds, filters);
      for (const [a, b] of ranges) {
        const m = cov.missingDays(ds.id, a, b, cov.acceptKeys(key));
        if (!m.days.length) continue;
        jobs.push({ dtil: d.dtil, from: m.days[0], to: m.days.at(-1), missingDays: m.days.length, estCalls: 0, filters, chunkDays: 31 });
      }
    }
    return { dtils, jobs, unknown: store.corpsNotFetched(q.corps), remainingCalls: 0, mock: false, collecting: false };
  }
  if (path === '/perf' && method === 'GET') return store.performance(q);
  if (path === '/perf/years' && method === 'GET') return store.orderYears();
  if (path === '/perf/top' && method === 'GET') return store.perfTop(q);

  if (path === '/items/suggest' && method === 'GET') return clsfc.suggestItems(q.kind, q.term, q.limit);
  if (path === '/items/status' && method === 'GET') return { ...clsfc.clsfcStatus(), syncing: false };
  if (path === '/suggest/order' && method === 'GET') return store.suggestOrderValues(q.field, q.term, q.dtil, q.limit);
  if (path === '/suggest/product' && method === 'GET') return store.suggestProductValues(q.field, q.term, q.dtil, q.limit);
  if (path === '/suggest' && method === 'GET') return store.suggest(q.field, q.term, q.limit);

  if (path === '/bookmarks' && method === 'GET') return store.listBookmarks();
  if (path === '/bookmarks' && method === 'POST') return store.addBookmark(body || {});
  if (path.startsWith('/bookmarks/') && method === 'DELETE') return store.removeBookmark(path.split('/')[2]);

  if (path === '/export' && method === 'GET') {
    const kind = q.kind === 'products' ? 'products' : 'orders';
    const search = kind === 'products' ? store.searchProducts : store.searchOrders;
    const all = [];
    for (let page = 1; page <= 50; page++) {
      const got = search({ ...q, page, size: 200 }).rows;
      all.push(...got);
      if (got.length < 200) break;
    }
    return { __text: store.toCsv(kind, all), __type: 'text/csv; charset=utf-8', __name: `g2b-${kind}-${new Date().toISOString().slice(0, 10)}.csv` };
  }

  throw new HttpError(403, '모바일 검색용에서는 쓸 수 없는 기능입니다. 자료는 관리자 PC 에서 받아 배포합니다.');
}

/* ── 시작 ── */

let ready = null;
async function start() {
  state = await readState();
  sqlite3 = await sqlite3InitModule();
  pool = await sqlite3.installOpfsSAHPoolVfs({ name: POOL, initialCapacity: 6 });
  if (state.slot && pool.getFileNames().includes(state.slot)) setDb(openSlot(state.slot));
  if (!rawDb()) {
    if (!state.feed) {
      setPhase('need-link');
      await new Promise((resolve) => (needLink = resolve));
    }
    await checkFeed(); // 처음 — 기본자료를 받는다 (실패하면 화면이 다시 시도를 띄운다)
  }
  // 검색 코드는 DB 가 열린 뒤에 불러온다 (clsfc.js 는 불러올 때 표를 만든다)
  [store, cov, clsfc, spec, conf] = await Promise.all([
    import('./srv/search.js'),
    import('./srv/coverage.js'),
    import('./srv/clsfc.js'),
    import('./srv/g2b/spec.js'),
    import('./srv/config.js'),
  ]);
  setPhase('ready');
  // 이미 자료가 있으면 화면부터 띄우고 뒤에서 새 자료를 확인한다
  checkFeed().catch(() => {});
  setInterval(() => checkFeed().catch(() => {}), CHECK_MS);
}
let needLink = null;

function startOnce() {
  if (!ready) {
    ready = start().catch((err) => {
      ready = null; // 다시 시도할 수 있게
      status.error = err.message;
      setPhase(state.feed ? 'error' : 'need-link');
      throw err;
    });
  }
  return ready;
}

self.addEventListener('message', async (e) => {
  const msg = e.data || {};
  if (msg.type === 'start') return startOnce().catch(() => {});
  if (msg.type === 'link') {
    await writeState({ feed: String(msg.link || '').trim() });
    listCache = { at: 0, map: new Map() };
    if (needLink) needLink(), (needLink = null);
    else startOnce().catch(() => {});
    return;
  }
  if (msg.type === 'check') return checkFeed().catch(() => {});
  if (msg.type === 'reset') {
    // 받은 자료를 지우고 처음부터 (화면의 "자료 다시 받기")
    try {
      rawDb()?.close();
    } catch {}
    setDb(null);
    for (const s of SLOTS) {
      try {
        pool?.unlink(s);
      } catch {}
    }
    await writeState({ slot: null, baseId: null, mbaseId: null, applied: 0 });
    return post({ type: 'reload', why: '받은 자료를 지웠습니다.' });
  }
  if (msg.type !== 'api') return;
  try {
    await startOnce();
    const out = await route(String(msg.method || 'GET').toUpperCase(), msg.url, msg.body);
    post({ type: 'api', id: msg.id, status: 200, body: out });
  } catch (err) {
    post({ type: 'api', id: msg.id, status: err.status || 500, body: { error: err.message || String(err) } });
  }
});
