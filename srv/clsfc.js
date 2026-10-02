/**
 * 조달청 물품분류 목록 — 세부품명(10자리)·품명(8자리) 전체를 받아 두고 자동완성에 쓴다.
 *
 * 출처: 조달청_물품목록정보서비스 (data.go.kr 15129417, 쇼핑몰 API 와 같은 인증키)
 *   getPrdctClsfcNoUnit10Info02  세부품명 전체 (약 2만 3천 개)
 *   getPrdctClsfcNoUnit8Info02   품명 전체 (약 1만 1천 개)
 * 한 번 받아 두면 자동완성은 API 를 쓰지 않는다. 30일이 지나면 뒤에서 한 번 새로 받는다.
 */

import { db, nowIso, transaction, getConfig, setConfig } from './db.js';
import { callOperation } from './g2b/client.js';
import { serviceKey, isMock } from './config.js';

const BASE = 'https://apis.data.go.kr/1230000/ao/ThngListInfoService02';
const REFRESH_DAYS = 30;

db.exec(`
CREATE TABLE IF NOT EXISTS clsfc (
  kind      TEXT NOT NULL,          -- dtil = 세부품명(10자리), clsfc = 품명(8자리)
  code      TEXT NOT NULL,
  name      TEXT NOT NULL,
  cho       TEXT,                   -- 초성 (ㄴㅅㄹ 로 찾기)
  eng       TEXT,
  use_yn    INTEGER DEFAULT 1,
  chg_date  TEXT,
  PRIMARY KEY (kind, code)
);
CREATE INDEX IF NOT EXISTS idx_clsfc_name ON clsfc(kind, name);
CREATE INDEX IF NOT EXISTS idx_oi_prdct_clsfc ON order_item(prdct_clsfc_nm);
`);

/* ── 초성 ─────────────────────────────────────────────────────────── */

const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';

export function choseong(s) {
  let out = '';
  for (const ch of String(s || '')) {
    const c = ch.charCodeAt(0) - 0xac00;
    out += c >= 0 && c < 11172 ? CHO[Math.floor(c / 588)] : ch;
  }
  return out;
}

const isChoOnly = (s) => /^[ㄱ-ㅎ]+$/.test(s);

/* ── 받기 ─────────────────────────────────────────────────────────── */

let syncing = null;

export function clsfcStatus() {
  const r = db.prepare(`SELECT kind, COUNT(*) c FROM clsfc GROUP BY kind`).all();
  const by = Object.fromEntries(r.map((x) => [x.kind, x.c]));
  return {
    dtil: by.dtil || 0,
    clsfc: by.clsfc || 0,
    syncedAt: getConfig('clsfcSyncedAt', null),
    syncing: Boolean(syncing),
    error: getConfig('clsfcError', null),
  };
}

const OPS = [
  { kind: 'dtil', op: 'getPrdctClsfcNoUnit10Info02', code: 'dtilPrdctClsfcNo', name: 'dtilPrdctClsfcNoNm', eng: 'dtilPrdctClsfcNoEngNm' },
  { kind: 'clsfc', op: 'getPrdctClsfcNoUnit8Info02', code: 'prdctClsfcNo', name: 'prdctClsfcNoNm', eng: 'prdctClsfcNoEngNm' },
];

/** 전체 목록을 다시 받는다 (약 36회 호출). 이미 받는 중이면 그 작업을 돌려준다. */
export function syncClsfc() {
  if (syncing) return syncing;
  if (isMock()) return Promise.reject(new Error('인증키를 넣어야 품목 목록을 받을 수 있습니다.'));
  syncing = (async () => {
    try {
      const upsert = db.prepare(
        `INSERT OR REPLACE INTO clsfc(kind, code, name, cho, eng, use_yn, chg_date) VALUES(?,?,?,?,?,?,?)`
      );
      for (const o of OPS) {
        for (let page = 1; page <= 100; page++) {
          const r = await callOperation({
            operation: o.op,
            serviceKey: serviceKey(),
            baseUrl: BASE,
            params: { pageNo: String(page), numOfRows: '999' },
          });
          transaction(() => {
            for (const it of r.items) {
              const code = String(it[o.code] || '').trim();
              const name = String(it[o.name] || '').trim();
              if (!code || !name) continue;
              upsert.run(o.kind, code, name, choseong(name), it[o.eng] || '', it.useYn === 'N' ? 0 : 1, it.chgDate || '');
            }
          });
          if (r.items.length < 999 || page * 999 >= Number(r.totalCount || 0)) break;
        }
      }
      setConfig('clsfcSyncedAt', nowIso());
      setConfig('clsfcError', null);
      return clsfcStatus();
    } catch (err) {
      setConfig('clsfcError', err.message);
      throw err;
    } finally {
      syncing = null;
    }
  })();
  return syncing;
}

/** 목록이 비었거나 오래됐으면 뒤에서 받는다 (서버 시작 때 부른다). */
export function refreshClsfcIfStale() {
  if (isMock()) return;
  const s = clsfcStatus();
  const old = !s.syncedAt || Date.now() - Date.parse(s.syncedAt) > REFRESH_DAYS * 86400000;
  if ((old || !s.dtil) && !s.error) syncClsfc().catch(() => {});
}

/* ── 찾기 ─────────────────────────────────────────────────────────── */

/**
 * 자동완성 후보. 조달청 목록에서 이름(중간 글자 포함)·초성·번호로 찾고,
 * 이 PC 에 거래가 많이 저장된 품목을 위로 올린다.
 * 목록을 아직 받지 않았으면 저장된 거래내역의 이름으로 대신 찾는다.
 */
export function suggestItems(kind, term, limit = 15) {
  const k = kind === 'clsfc' ? 'clsfc' : 'dtil';
  const t = String(term || '').trim();
  const n = Math.min(Math.max(Number(limit) || 15, 1), 50);
  if (!t) return [];
  const usedCol = k === 'dtil' ? 'dtil_clsfc_nm' : 'prdct_clsfc_nm';

  const have = db.prepare(`SELECT 1 FROM clsfc WHERE kind = ? LIMIT 1`).get(k);
  if (!have) {
    return db
      .prepare(
        `SELECT ${usedCol} AS name, '' AS code, '' AS parent, COUNT(*) AS cnt FROM order_item
          WHERE ${usedCol} LIKE ? GROUP BY ${usedCol} ORDER BY cnt DESC LIMIT ?`
      )
      .all(`%${t}%`, n);
  }

  let cond;
  let args;
  if (/^\d{2,10}$/.test(t)) {
    cond = 'c.code LIKE ?';
    args = [t + '%'];
  } else if (isChoOnly(t)) {
    cond = 'c.cho LIKE ?';
    args = [`%${t}%`];
  } else {
    // 완성된 글자를 쳤으면 이름으로만 찾는다 (초성까지 섞으면 "논슬" 에 "남성용…" 이 딸려 나온다).
    cond = 'c.name LIKE ?';
    args = [`%${t}%`];
  }

  // 세부품명은 앞 8자리가 상위 품명이다.
  const parentJoin =
    k === 'dtil' ? `LEFT JOIN clsfc p ON p.kind = 'clsfc' AND p.code = substr(c.code, 1, 8)` : '';
  const parentCol = k === 'dtil' ? 'p.name' : `''`;

  const rows = db
    .prepare(
      `SELECT c.code, c.name, ${parentCol} AS parent, c.use_yn,
              (SELECT COUNT(*) FROM order_item o WHERE o.${usedCol} = c.name) AS cnt
         FROM clsfc c ${parentJoin}
        WHERE c.kind = ? AND ${cond}
        ORDER BY c.use_yn DESC,
                 CASE WHEN c.name = ? OR c.cho = ? THEN 0 WHEN c.name LIKE ? OR c.cho LIKE ? THEN 1 ELSE 2 END,
                 cnt DESC, length(c.name), c.name
        LIMIT ?`
    )
    .all(k, ...args, t, t, t + '%', t + '%', n);
  return rows.map((r) => ({ code: r.code, name: r.name, parent: r.parent || '', cnt: r.cnt, unused: !r.use_yn }));
}
