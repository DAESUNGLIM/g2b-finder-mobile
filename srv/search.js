/**
 * 로컬 DB 검색·집계. API 를 부르지 않으므로 트래픽을 쓰지 않는다.
 */

import { db } from './db.js';
import { myCorps } from './config.js';

const clampInt = (v, min, max, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), min), max) : dflt;
};

const like = (v) => `%${String(v).trim()}%`;

/**
 * 세부품명 조건 — 넣은 글자가 조달청 물품분류 목록(없으면 저장된 자료)의 세부품명과 정확히 같으면
 * 그 품목만 (=), 아니면 이름에 들어 있는 것 모두 (LIKE).
 * "태양광발전장치" 로 찾을 때 "건물일체형태양광발전장치" 가 섞이지 않게 하면서, "태양광" 처럼 일부만 넣어도 찾게.
 */
function isDtilName(t) {
  try {
    if (db.prepare(`SELECT 1 FROM clsfc WHERE kind = 'dtil' AND name = ? LIMIT 1`).get(t)) return true;
  } catch {} // 물품분류 목록을 아직 받지 않았으면 표가 없을 수 있다
  return Boolean(
    db.prepare('SELECT 1 FROM order_item WHERE dtil_clsfc_nm = ? LIMIT 1').get(t) ||
      db.prepare('SELECT 1 FROM product WHERE dtil_clsfc_nm = ? LIMIT 1').get(t)
  );
}
function dtilWhere(w, value) {
  const t = String(value ?? '').trim();
  if (!t) return w;
  return isDtilName(t) ? w.add('dtil_clsfc_nm = ?', t) : w.add('dtil_clsfc_nm LIKE ?', like(t));
}

/**
 * 파일로 넣은 쇼핑몰 등록품목(전체 등록 내역은 100만 줄)은 휴대폰에 통째로 보내지 않고 세부품명 묶음 64개로 나눠 두었다가,
 * 휴대폰이 그 세부품명을 검색할 때 그 묶음만 받는다. 세부품명 → 묶음 번호(00~3f) — 관리자 PC(publish.js)와 휴대폰(mobile/worker.js)이 같이 쓴다.
 */
export const PD_BUCKETS = 64;
export function pdBucket(dtil) {
  let h = 0x811c9dc5; // FNV-1a
  for (const ch of String(dtil ?? '')) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h % PD_BUCKETS).toString(16).padStart(2, '0');
}

/** 세부품명 조건(일부만 넣어도 됨)에 드는 세부품명 이름들 — dtilWhere 와 같은 규칙, 이름은 물품분류 목록에서 */
export function dtilNamesFor(term) {
  const t = String(term ?? '').trim();
  if (!t) return [];
  if (isDtilName(t)) return [t];
  try {
    return db.prepare(`SELECT DISTINCT name FROM clsfc WHERE kind = 'dtil' AND name LIKE ? LIMIT 300`).all(like(t)).map((r) => r.name);
  } catch {
    return [];
  }
}

/** WHERE 절과 바인딩 값을 같이 모아주는 작은 헬퍼 */
function where() {
  const parts = [];
  const args = [];
  return {
    add(sql, ...values) {
      parts.push(sql);
      args.push(...values);
      return this;
    },
    /** 값이 비어 있으면 조건을 넣지 않는다. */
    maybe(value, sql, mapper = (v) => v) {
      if (value === undefined || value === null || String(value).trim() === '') return this;
      return this.add(sql, mapper(value));
    },
    clause() {
      return parts.length ? 'WHERE ' + parts.join(' AND ') : '';
    },
    args,
  };
}

/**
 * 내 회사 조건 (사업자번호 우선, 없으면 업체명).
 * idx 를 주면 설정에 등록한 회사 가운데 그 한 곳만, 없으면 등록한 회사 전부.
 */
function myCorpClause(w, prefix = '', idx = '') {
  const all = myCorps();
  const i = String(idx ?? '').trim() === '' ? -1 : Number(idx);
  const corps = i >= 0 && all[i] ? [all[i]] : all;
  if (!corps.length) return false;
  const ors = [];
  for (const c of corps) {
    if (c.bizno) {
      ors.push(`REPLACE(${prefix}corp_bizno, '-', '') = ?`);
      w.args.push(c.bizno);
    } else if (c.name) {
      ors.push(`${prefix}corp_nm = ?`);
      w.args.push(c.name);
    }
  }
  if (!ors.length) return false;
  w.add('(' + ors.join(' OR ') + ')');
  return true;
}

/* ── 품목 검색 ────────────────────────────────────────────────────── */

const PRODUCT_SORTS = {
  recent: 'rgst_date DESC, cntrct_no DESC',
  priceAsc: 'price ASC',
  priceDesc: 'price DESC',
  corp: 'corp_nm ASC, price ASC',
  name: 'dtil_clsfc_nm ASC, spec_nm ASC',
};

export function searchProducts(q = {}) {
  const page = clampInt(q.page, 1, 100000, 1);
  const size = clampInt(q.size, 1, 200, 50);
  const w = where();

  w.maybe(q.dataset, 'dataset = ?');
  w.maybe(q.clsfc, 'prdct_clsfc_nm LIKE ?', like);
  dtilWhere(w, q.dtil);
  // 계약업체 칸에 사업자번호를 넣어도 찾는다 (칸 안내대로)
  const corpDigits = String(q.corp || '').replace(/[^0-9]/g, '');
  if (corpDigits.length >= 3) w.add("(corp_nm LIKE ? OR REPLACE(corp_bizno,'-','') LIKE ?)", like(q.corp), like(corpDigits));
  else w.maybe(q.corp, 'corp_nm LIKE ?', like);
  w.maybe(q.bizno, "REPLACE(corp_bizno,'-','') LIKE ?", (v) => like(String(v).replace(/[^0-9]/g, '')));
  w.maybe(q.idntNo, 'prdct_idnt_no = ?', (v) => String(v).trim());
  w.maybe(q.cntrctNo, 'cntrct_no LIKE ?', like);
  if (String(q.keyword || '').trim()) {
    w.add(
      '(prdct_clsfc_nm LIKE ? OR dtil_clsfc_nm LIKE ? OR spec_nm LIKE ? OR corp_nm LIKE ? OR makr_nm LIKE ?)',
      like(q.keyword), like(q.keyword), like(q.keyword), like(q.keyword), like(q.keyword)
    );
  }
  if (Number(q.priceMin) > 0) w.add('price >= ?', Number(q.priceMin));
  if (Number(q.priceMax) > 0) w.add('price <= ?', Number(q.priceMax));
  if (q.masYn === 'Y') w.add('mas_yn = 1');
  if (q.masYn === 'N') w.add('mas_yn = 0');
  if (q.exclcYn === 'Y') w.add('exclc_yn = 1');
  if (q.smetprYn === 'Y') w.add('smetpr_yn = 1');
  w.maybe(q.from, 'rgst_date >= ?', (v) => String(v).replace(/[^0-9]/g, ''));
  w.maybe(q.to, 'rgst_date <= ?', (v) => String(v).replace(/[^0-9]/g, ''));
  if (q.mine === true || q.mine === 'true') myCorpClause(w, '', q.myIdx);
  // 업체소재지: 품목의 본사 소재지, 없으면 같은 업체의 다른 자료에서 모은 소재지 (corpinfo.js)
  const LOC = `COALESCE(NULLIF(hdoffce, ''), ci.loc, '')`;
  w.maybe(q.loc, `${LOC} LIKE ?`, like);

  const order = PRODUCT_SORTS[q.sort] || PRODUCT_SORTS.recent;
  // 기본은 지금 쇼핑몰에 있는 품목만 (db.js 의 product_current). includeOld 면 내려간·계약종료 품목과 옛 버전까지.
  const table = q.includeOld === true || q.includeOld === 'true' ? 'product' : 'product_current';
  const from = `${table} LEFT JOIN corp_info ci ON ci.bizno = REPLACE(corp_bizno, '-', '')`;
  const total = db.prepare(`SELECT COUNT(*) c FROM ${from} ${w.clause()}`).get(...w.args).c;
  const rows = db
    .prepare(
      `SELECT dataset, cntrct_no, cntrct_sno, prdct_idnt_no, prdct_clsfc_nm, dtil_clsfc_nm,
              spec_nm, corp_nm, corp_bizno, entrprs_div, cntrct_mthd, price, unit, makr_nm,
              orgplce, sply_rgn, dlvr_days, mas_yn, exclc_yn, smetpr_yn, cert_list, img_url,
              cntrct_bgn, cntrct_end, rgst_date, COALESCE(delisted, 0) delisted,
              ${LOC} corp_loc, COALESCE(fctry, '') fctry
         FROM ${from} ${w.clause()} ORDER BY ${order} LIMIT ? OFFSET ?`
    )
    .all(...w.args, size, (page - 1) * size);

  return { total, page, size, rows };
}

/* ── 거래내역(납품요구 상세) 검색 ─────────────────────────────────── */

/**
 * 목록은 납품요구번호로 묶어서 보여준다 — 그래서 어떤 정렬을 골라도
 * 같은 번호의 품목이 흩어지지 않도록 '건' 단위로 먼저 줄을 세운다.
 * 금액·단가 정렬은 건 안에서 가장 큰(작은) 값으로 건의 자리를 정한다.
 * w = PARTITION BY dlvr_req_no (아래 rows 쿼리의 WINDOW 절)
 */
const ORDER_SORTS = {
  recent: 'rcpt_date DESC, dlvr_req_no DESC, CAST(prdct_sno AS INTEGER)',
  amtDesc: 'MAX(amt) OVER w DESC, dlvr_req_no DESC, amt DESC',
  amtAsc: 'MIN(amt) OVER w ASC, dlvr_req_no DESC, amt ASC',
  uprcAsc: 'MIN(uprc) OVER w ASC, dlvr_req_no DESC, uprc ASC',
  uprcDesc: 'MAX(uprc) OVER w DESC, dlvr_req_no DESC, uprc DESC',
  instt: 'dminstt_nm ASC, rcpt_date DESC, dlvr_req_no DESC, CAST(prdct_sno AS INTEGER)',
  corp: 'corp_nm ASC, rcpt_date DESC, dlvr_req_no DESC, CAST(prdct_sno AS INTEGER)',
};

/** 거래내역 검색의 공통 조건 — 목록과 집계가 같은 필터를 쓴다. */
function orderWhere(q) {
  const w = where();
  w.maybe(q.from, 'rcpt_date >= ?', (v) => String(v).replace(/[^0-9]/g, ''));
  w.maybe(q.to, 'rcpt_date <= ?', (v) => String(v).replace(/[^0-9]/g, ''));
  w.maybe(q.corp, 'corp_nm LIKE ?', like);
  w.maybe(q.bizno, "REPLACE(corp_bizno,'-','') LIKE ?", (v) => like(String(v).replace(/[^0-9]/g, '')));
  w.maybe(q.instt, 'dminstt_nm LIKE ?', like);
  w.maybe(q.insttDiv, 'dminstt_div = ?');
  w.maybe(q.rgn, 'dminstt_rgn LIKE ?', like);
  // 업체소재지는 거래내역에 없어서 corp_info(파일의 계약시점 업체소재시군구·단가계약 본사 소재지)로 찾는다.
  w.maybe(q.corpLoc, 'corp_bizno IN (SELECT bizno FROM corp_info WHERE loc LIKE ?)', like);
  w.maybe(q.clsfc, 'prdct_clsfc_nm LIKE ?', like);
  dtilWhere(w, q.dtil);
  w.maybe(q.idntNo, 'prdct_idnt_no = ?', (v) => String(v).trim());
  w.maybe(q.dlvrReqNo, 'dlvr_req_no LIKE ?', like);
  w.maybe(q.cntrctNo, 'cntrct_no LIKE ?', like);
  if (String(q.keyword || '').trim()) {
    w.add(
      '(dlvr_req_nm LIKE ? OR prdct_clsfc_nm LIKE ? OR dtil_clsfc_nm LIKE ? OR spec_nm LIKE ? OR corp_nm LIKE ? OR dminstt_nm LIKE ?)',
      like(q.keyword), like(q.keyword), like(q.keyword), like(q.keyword), like(q.keyword), like(q.keyword)
    );
  }
  if (Number(q.amtMin) > 0) w.add('amt >= ?', Number(q.amtMin));
  if (Number(q.amtMax) > 0) w.add('amt <= ?', Number(q.amtMax));
  if (q.masYn === 'Y') w.add('mas_yn = 1');
  if (q.masYn === 'N') w.add('mas_yn = 0');
  if (q.exclcYn === 'Y') w.add('exclc_yn = 1');
  if (q.smetprYn === 'Y') w.add('smetpr_yn = 1');
  if (q.finalOnly === true || q.finalOnly === 'true') w.add('fnl_yn = 1');
  if (q.mine === true || q.mine === 'true') myCorpClause(w, '', q.myIdx);
  return w;
}

export function searchOrders(q = {}) {
  const page = clampInt(q.page, 1, 100000, 1);
  const size = clampInt(q.size, 1, 200, 50);
  const w = orderWhere(q);
  const order = ORDER_SORTS[q.sort] || ORDER_SORTS.recent;

  const sum = db
    .prepare(
      `SELECT COUNT(*) c, COALESCE(SUM(amt),0) amt, COALESCE(SUM(qty),0) qty,
              COUNT(DISTINCT dlvr_req_no) reqs, COUNT(DISTINCT dminstt_nm) instts,
              COUNT(DISTINCT corp_nm) corps
         FROM order_latest ${w.clause()}`
    )
    .get(...w.args);

  const rows = db
    .prepare(
      `SELECT dlvr_req_no, chg_ord, prdct_sno, rcpt_date, dlvr_req_nm, cntrct_no,
              corp_nm, corp_bizno, corp_div, dminstt_cd, dminstt_nm, dminstt_div, dminstt_rgn,
              prdct_clsfc_nm, dtil_clsfc_nm, prdct_idnt_no, spec_nm,
              uprc, qty, unit, amt, dlvr_tmlmt, cncls_stle,
              mas_yn, exclc_yn, smetpr_yn, cnstwk_mtrl_yn, fnl_yn,
              (SELECT loc FROM corp_info ci WHERE ci.bizno = corp_bizno) corp_loc
         FROM order_latest ${w.clause()}
        WINDOW w AS (PARTITION BY dlvr_req_no)
        ORDER BY ${order} LIMIT ? OFFSET ?`
    )
    .all(...w.args, size, (page - 1) * size);

  return {
    total: sum.c,
    summary: {
      count: sum.c,
      amount: sum.amt,
      qty: sum.qty,
      requests: sum.reqs,
      institutions: sum.instts,
      corps: sum.corps,
    },
    page,
    size,
    rows,
  };
}

/* ── 집계 ─────────────────────────────────────────────────────────── */

const GROUPS = {
  month: { expr: "substr(rcpt_date,1,6)", label: '월' },
  year: { expr: "substr(rcpt_date,1,4)", label: '연도' },
  instt: { expr: 'dminstt_nm', label: '수요기관' },
  insttDiv: { expr: 'dminstt_div', label: '기관구분' },
  rgn: { expr: 'dminstt_rgn', label: '기관지역' },
  corp: { expr: 'corp_nm', label: '업체' },
  corpSido: { expr: `COALESCE((SELECT substr(loc, 1, instr(loc || ' ', ' ') - 1) FROM corp_info ci WHERE ci.bizno = corp_bizno), '(소재지 정보 없음)')`, label: '업체소재 시·도' },
  corpLoc: { expr: `COALESCE((SELECT loc FROM corp_info ci WHERE ci.bizno = corp_bizno), '(소재지 정보 없음)')`, label: '업체소재지' },
  clsfc: { expr: 'prdct_clsfc_nm', label: '품명' },
  dtil: { expr: 'dtil_clsfc_nm', label: '세부품명' },
  spec: { expr: 'spec_nm', label: '물품규격명' },
  cncls: { expr: 'cncls_stle', label: '계약체결형태' },
};

export function aggregateOrders(q = {}) {
  const by = GROUPS[q.by] ? q.by : 'month';
  const g = GROUPS[by];
  const time = by === 'month' || by === 'year';
  // 기간 묶음은 잘리면 최근 구간이 빠지므로 전부 낸다.
  const limit = time ? 1000 : clampInt(q.limit, 1, 500, 50);
  const w = orderWhere(q);
  w.add(`${g.expr} <> ''`);

  const orderBy = time ? `${g.expr} ASC` : 'amt DESC';
  const rows = db
    .prepare(
      `SELECT ${g.expr} AS bucket, COUNT(*) cnt, COALESCE(SUM(amt),0) amt,
              COALESCE(SUM(qty),0) qty, COUNT(DISTINCT dlvr_req_no) reqs
         FROM order_latest ${w.clause()}
        GROUP BY ${g.expr} ORDER BY ${orderBy} LIMIT ?`
    )
    .all(...w.args, limit);

  // 비중은 잘린 목록이 아니라 조건 전체 합계를 기준으로 한다 (그 외 묶음도 따로 알려준다).
  const all = db
    .prepare(
      `SELECT COUNT(DISTINCT ${g.expr}) buckets, COALESCE(SUM(amt),0) amt, COUNT(*) cnt
         FROM order_latest ${w.clause()}`
    )
    .get(...w.args);
  const shownAmt = rows.reduce((s, r) => s + r.amt, 0);
  const shownCnt = rows.reduce((s, r) => s + r.cnt, 0);
  return {
    by,
    label: g.label,
    rows,
    totalAmt: all.amt,
    buckets: all.buckets,
    rest: { buckets: all.buckets - rows.length, amt: all.amt - shownAmt, cnt: all.cnt - shownCnt },
  };
}

/**
 * 한 품목 줄의 변경 이력 — 차수마다 한 줄.
 * 검색·합계는 최신 차수만 쓰지만(order_latest), 원본은 order_item 에 그대로 남아 있다.
 */
export function orderHistory(no, sno) {
  return db
    .prepare(
      `SELECT chg_ord, rcpt_date, dlvr_req_nm, dminstt_nm, corp_nm, spec_nm,
              uprc, qty, unit, amt, dlvr_tmlmt
         FROM order_item
        WHERE dlvr_req_no = ? AND prdct_sno = ?
        ORDER BY chg_ord`
    )
    .all(String(no ?? '').trim(), String(sno ?? '').trim());
}

/* ── 자동완성 / 개요 ──────────────────────────────────────────────── */

export function suggest(field, term, limit = 15) {
  const cols = {
    dtil: ['order_item', 'dtil_clsfc_nm'],
    clsfc: ['order_item', 'prdct_clsfc_nm'],
    corp: ['order_item', 'corp_nm'],
    instt: ['order_item', 'dminstt_nm'],
    rgn: ['order_item', 'dminstt_rgn'],
    productDtil: ['product', 'dtil_clsfc_nm'],
    productCorp: ['product', 'corp_nm'],
  };
  const target = cols[field];
  if (!target) return [];
  const [table, col] = target;
  const t = String(term || '').trim();
  const w = t ? `WHERE ${col} LIKE ?` : `WHERE ${col} <> ''`;
  const args = t ? [like(t)] : [];
  return db
    .prepare(
      `SELECT ${col} AS value, COUNT(*) cnt FROM ${table} ${w} AND ${col} <> ''
        GROUP BY ${col} ORDER BY cnt DESC LIMIT ?`
    )
    .all(...args, clampInt(limit, 1, 50, 15));
}

/**
 * 거래내역 검색 칸 자동완성 — 저장된 거래내역에 실제로 있는 값만, 금액이 큰 순.
 * dtil(세부품명)이 있으면 그 품목 거래 안에서만 찾는다. 속도를 위해 변경차수는 따지지 않는다(대략값).
 *   corp  : 업체명 (사업자번호 숫자로도 찾음) → { value, sub: 사업자번호, cnt, amt }
 *   instt : 수요기관                          → { value, sub: 지역, cnt, amt }
 *   rgn   : 기관지역 — "대구광역시" 같은 시·도 묶음도 함께 → { value, sub, cnt, amt }
 *   corpLoc : 업체소재지 — 소재지를 아는 업체(corp_info)만, 시·도 묶음 포함 → { value, sub, cnt, amt }
 */
export function suggestOrderValues(field, term, dtil, limit = 12) {
  const t = String(term || '').trim();
  if (!t) return [];
  const lim = clampInt(limit, 1, 30, 12);
  const w = where();
  dtilWhere(w, dtil);
  const prefix = t.replace(/[%_]/g, '') + '%';

  if (field === 'corp') {
    const digits = t.replace(/[^0-9]/g, '');
    if (digits.length >= 3) w.add("(corp_nm LIKE ? OR REPLACE(corp_bizno,'-','') LIKE ?)", like(t), `%${digits}%`);
    else w.add('corp_nm LIKE ?', like(t));
    return db
      .prepare(
        `SELECT corp_nm value, MAX(corp_bizno) sub, COUNT(*) cnt, COALESCE(SUM(amt),0) amt
           FROM order_item ${w.clause()} AND corp_nm <> ''
          GROUP BY corp_nm ORDER BY (corp_nm LIKE ?) DESC, amt DESC LIMIT ?`
      )
      .all(...w.args, prefix, lim);
  }

  if (field === 'instt') {
    w.add('dminstt_nm LIKE ?', like(t));
    return db
      .prepare(
        `SELECT dminstt_nm value, MAX(dminstt_rgn) sub, COUNT(*) cnt, COALESCE(SUM(amt),0) amt
           FROM order_item ${w.clause()} AND dminstt_nm <> ''
          GROUP BY dminstt_nm ORDER BY (dminstt_nm LIKE ?) DESC, amt DESC LIMIT ?`
      )
      .all(...w.args, prefix, lim);
  }

  if (field === 'rgn' || field === 'corpLoc') {
    const rows =
      field === 'rgn'
        ? (w.add("dminstt_rgn <> ''"),
          db
            .prepare(
              `SELECT dminstt_rgn value, COUNT(*) cnt, COALESCE(SUM(amt),0) amt
                 FROM order_item ${w.clause()} GROUP BY dminstt_rgn`
            )
            .all(...w.args))
        : (w.add("ci.loc <> ''"),
          db
            .prepare(
              `SELECT ci.loc value, COUNT(*) cnt, COALESCE(SUM(amt),0) amt
                 FROM order_item JOIN corp_info ci ON ci.bizno = order_item.corp_bizno
                 ${w.clause()} GROUP BY ci.loc`
            )
            .all(...w.args));
    return withSido(rows, t, lim);
  }
  return [];
}

/**
 * 지역 후보에 시·도 묶음을 더하고 term 으로 거른다.
 * "대구" 로 치면 "대구광역시" 전체 묶음이 먼저 나오게. rows: { value, cnt, amt }
 */
function withSido(rows, t, lim) {
  const sido = new Map();
  for (const r of rows) {
    const k = r.value.split(' ')[0];
    const s = sido.get(k) || { value: k, sub: '시·도 전체', cnt: 0, amt: 0, parts: 0 };
    s.cnt += r.cnt;
    s.amt += r.amt;
    s.parts++;
    sido.set(k, s);
  }
  const all = [...[...sido.values()].filter((s) => s.parts > 1 || !rows.some((r) => r.value === s.value)), ...rows];
  const lower = t.toLowerCase();
  // 앞에서부터 맞는 것 먼저 ("대구" → 대구광역시 …, 그다음 "…해운대구")
  return all
    .filter((r) => r.value.toLowerCase().includes(lower))
    .map((r) => ({ value: r.value, sub: r.sub || '', cnt: r.cnt, amt: r.amt, score: r.value.startsWith(t) ? 0 : 1 }))
    .sort((a, b) => a.score - b.score || (a.sub ? -1 : 0) - (b.sub ? -1 : 0) || b.amt - a.amt || b.cnt - a.cnt)
    .slice(0, lim)
    .map(({ score, ...r }) => r);
}

/**
 * 등록품목 검색 칸 자동완성 — 지금 쇼핑몰에 있는 품목(product_current)에서, 등록 품목 수가 많은 순.
 * dtil(세부품명)이 있으면 그 품목 안에서만 찾는다.
 *   corp : 계약업체 (사업자번호 숫자로도 찾음) → { value, sub: 사업자번호, cnt }
 *   loc  : 업체소재지 (본사 소재지, 없으면 corp_info) — 시·도 묶음 포함 → { value, sub, cnt }
 */
export function suggestProductValues(field, term, dtil, limit = 12) {
  const t = String(term || '').trim();
  if (!t) return [];
  const lim = clampInt(limit, 1, 30, 12);
  const w = where();
  dtilWhere(w, dtil);
  const from = `product_current LEFT JOIN corp_info ci ON ci.bizno = REPLACE(corp_bizno, '-', '')`;

  if (field === 'corp') {
    const digits = t.replace(/[^0-9]/g, '');
    if (digits.length >= 3) w.add("(corp_nm LIKE ? OR REPLACE(corp_bizno,'-','') LIKE ?)", like(t), `%${digits}%`);
    else w.add('corp_nm LIKE ?', like(t));
    return db
      .prepare(
        `SELECT corp_nm value, MAX(corp_bizno) sub, COUNT(*) cnt, 0 amt
           FROM product_current ${w.clause()} AND corp_nm <> ''
          GROUP BY corp_nm ORDER BY (corp_nm LIKE ?) DESC, cnt DESC LIMIT ?`
      )
      .all(...w.args, t.replace(/[%_]/g, '') + '%', lim);
  }
  if (field === 'loc') {
    const LOC = `COALESCE(NULLIF(hdoffce, ''), ci.loc, '')`;
    w.add(`${LOC} <> ''`);
    const rows = db
      .prepare(`SELECT ${LOC} value, COUNT(*) cnt, 0 amt FROM ${from} ${w.clause()} GROUP BY value`)
      .all(...w.args);
    return withSido(rows, t, lim);
  }
  return [];
}

/* ── 실적 (업체를 골라 비교) ─────────────────────────────────────── */

/** 실적 탭에서 업체를 찾는다 — 거래내역에 있는 업체만 (실적이 있는 곳). */
export function suggestCorps(term, limit = 12) {
  const t = String(term || '').trim();
  if (!t) return [];
  const digits = t.replace(/[^0-9]/g, '');
  const cond = digits.length >= 3 ? `(corp_nm LIKE ? OR REPLACE(corp_bizno, '-', '') LIKE ?)` : 'corp_nm LIKE ?';
  const args = digits.length >= 3 ? [like(t), `%${digits}%`] : [like(t)];
  const lim = clampInt(limit, 1, 30, 12);
  // 1) 후보 업체를 업체명·사업자번호 색인만 훑어 먼저 고른다. order_latest 를 통째로 훑으면
  //    모든 줄마다 최신 변경차수를 따져 자동완성이 0.3초 넘게 걸린다.
  const cand = db
    .prepare(
      `SELECT corp_bizno FROM order_item WHERE corp_nm LIKE ? AND corp_bizno <> ''
        GROUP BY corp_nm, corp_bizno ORDER BY SUM(amt) DESC LIMIT ?`
    )
    .all(like(t), lim * 3);
  if (digits.length >= 3)
    cand.push(
      ...db
        .prepare(`SELECT DISTINCT corp_bizno FROM order_item WHERE REPLACE(corp_bizno, '-', '') LIKE ? LIMIT ?`)
        .all(`%${digits}%`, lim * 3)
    );
  const raws = [...new Set(cand.map((r) => r.corp_bizno))];
  // 2) 그 업체들만 최신 변경차수로 합계. MAX(rcpt_date) 와 함께 고르면 corp_nm 은 가장 최근 거래의 이름이 된다.
  const rows = raws.length
    ? db
        .prepare(
          `SELECT REPLACE(corp_bizno, '-', '') bizno, corp_nm name, MAX(rcpt_date) last,
                  COUNT(*) cnt, COALESCE(SUM(amt), 0) amt
             FROM order_latest WHERE corp_bizno IN (${raws.map(() => '?').join(',')}) AND ${cond}
            GROUP BY REPLACE(corp_bizno, '-', '') ORDER BY amt DESC LIMIT ?`
        )
        .all(...raws, ...args, lim)
    : [];
  if (rows.length >= lim) return rows;
  // 3) 거래는 아직 없고 쇼핑몰 등록품목만 있는 업체 ("조달청에서 가져오기" 로 품목만 받은 업체도 추가할 수 있게)
  const have = new Set(rows.map((r) => r.bizno));
  const listed = db
    .prepare(
      `SELECT REPLACE(corp_bizno, '-', '') bizno, MAX(corp_nm) name, COUNT(DISTINCT prdct_idnt_no) listed
         FROM product_current WHERE ${cond} AND COALESCE(corp_bizno, '') <> ''
        GROUP BY REPLACE(corp_bizno, '-', '') ORDER BY listed DESC LIMIT ?`
    )
    .all(...args, lim);
  for (const r of listed) if (!have.has(r.bizno) && rows.length < lim) rows.push({ ...r, last: '', cnt: 0, amt: 0 });
  return rows;
}

/**
 * 업체들이 쇼핑몰에 등록한 세부품명 — 계약기간이 [from, to] 에 걸친 품목만 (저장된 등록품목 기준, 규격 많은 순).
 * 업체 실적 탭이 이 세부품명들의 거래내역을 고른 기간만큼 채운다.
 */
export function corpDtils(biznos, from, to) {
  if (!biznos.length) return [];
  return db
    .prepare(
      `SELECT dtil_clsfc_nm dtil, COUNT(DISTINCT prdct_idnt_no) specs FROM product
        WHERE REPLACE(corp_bizno, '-', '') IN (${biznos.map(() => '?').join(',')}) AND COALESCE(dtil_clsfc_nm, '') <> ''
          AND (COALESCE(cntrct_end, '') = '' OR cntrct_end >= ?) AND (COALESCE(cntrct_bgn, '') = '' OR cntrct_bgn <= ?)
        GROUP BY dtil_clsfc_nm ORDER BY specs DESC`
    )
    .all(...biznos, from, to);
}

/**
 * 쇼핑몰 등록품목을 조달청에서 업체 단위로 받아 본 적이 없는 업체 (corp_fetch — 업체 실적 탭의 "조달청에서 가져오기").
 * 받은 결과에 그 사업자번호가 있거나, 그 업체명으로 찾아 본 적이 있으면(못 찾았어도) 받은 것으로 친다.
 * 받지 않은 업체는 저장된 등록품목이 세부품명 단위로 받은 일부뿐이라, 등록한 세부품명을 다 안다고 할 수 없다.
 * @param {{bizno: string, name: string}[] | string} corps  (주소로 받을 때는 JSON)
 */
export function corpsNotFetched(corps) {
  if (typeof corps === 'string') {
    try {
      corps = JSON.parse(corps);
    } catch {
      corps = [];
    }
  }
  corps = (Array.isArray(corps) ? corps : []).slice(0, 50).map((c) => ({ bizno: String(c?.bizno || '').replace(/[^0-9]/g, ''), name: String(c?.name || '') }));
  if (!corps.length) return [];
  let saved = [];
  try {
    saved = db.prepare('SELECT term, result FROM corp_fetch').all();
  } catch {
    return corps; // 표가 아직 없다 (한 번도 받지 않음)
  }
  const terms = new Set(saved.map((r) => r.term));
  if (terms.has('*')) return []; // 쇼핑몰 전체 등록 내역 파일을 가져왔다 (importer.js)
  const biznos = new Set();
  for (const r of saved) {
    try {
      for (const c of JSON.parse(r.result).corps || []) biznos.add(String(c.bizno));
    } catch {}
  }
  return corps.filter((c) => !biznos.has(c.bizno) && !terms.has(String(c.name || '').replace(/\s+/g, '')));
}

/** '202601'~'202609' → 그 사이 모든 달 (연도는 '2024'~'2026', 분기는 '2025Q3'~'2026Q2') */
function fillPeriods(by, first, last) {
  const out = [];
  if (by === 'year') {
    for (let y = Number(first); y <= Number(last); y++) out.push(String(y));
    return out;
  }
  if (by === 'quarter') {
    let y = Number(first.slice(0, 4));
    let q = Number(first.slice(5));
    while (out.length < 200) {
      const b = `${y}Q${q}`;
      out.push(b);
      if (b >= last) break;
      if (++q > 4) (q = 1), y++;
    }
    return out;
  }
  let y = Number(first.slice(0, 4));
  let m = Number(first.slice(4, 6));
  while (out.length < 600) {
    const b = `${y}${String(m).padStart(2, '0')}`;
    out.push(b);
    if (b >= last) break;
    if (++m > 12) (m = 1), y++;
  }
  return out;
}

/** 연도 체크박스로 고른 해만 (떨어진 해도 가능). 시작일·종료일과 함께 쓴다. */
function perfYears(q) {
  return String(q.years || '')
    .split(',')
    .map((y) => y.replace(/[^0-9]/g, ''))
    .filter((y) => y.length === 4);
}

/**
 * 실적 탭 공통 조건 — 기간·연도와 검색 조건.
 *   fDtil   : 세부품명 (일부만 넣어도 됨)
 *   corpLoc : 업체소재지 (corp_info)
 *   rgn     : 수요기관 지역 (납품한 곳)
 */
function perfWhere(q, years = perfYears(q)) {
  const c = where();
  c.maybe(q.from, 'rcpt_date >= ?', (v) => String(v).replace(/[^0-9]/g, ''));
  c.maybe(q.to, 'rcpt_date <= ?', (v) => String(v).replace(/[^0-9]/g, ''));
  if (years.length) c.add(`substr(rcpt_date, 1, 4) IN (${years.map(() => '?').join(',')})`, ...years);
  dtilWhere(c, q.fDtil);
  c.maybe(q.corpLoc, 'corp_bizno IN (SELECT bizno FROM corp_info WHERE loc LIKE ?)', like);
  c.maybe(q.rgn, 'dminstt_rgn LIKE ?', like);
  return c;
}

/** 지금 쇼핑몰에 품목을 올린 업체 (product_current) — 업체소재지는 본사 소재지, 없으면 corp_info */
const LISTING_FROM = `product_current LEFT JOIN corp_info ci ON ci.bizno = REPLACE(corp_bizno, '-', '')`;

/**
 * 업체를 고르지 않고 조건만 넣었을 때 — 조건에 맞는 업체를 금액 큰 순으로.
 * market 은 조건 전체 합계(점유율 계산용).
 * 전부(limit 0)면 쇼핑몰에 등록만 하고 이 기간 납품이 없는 업체도 뒤에 붙인다
 * (기관지역 조건이 있으면 '납품한 곳' 이 없는 업체라 붙이지 않는다).
 */
/** { 사업자번호: 업체소재지 } — corp_info (파일의 계약시점 업체소재시군구·단가계약 본사 소재지) */
function corpLocs(biznos) {
  const out = {};
  for (let i = 0; i < biznos.length; i += 500) {
    const part = biznos.slice(i, i + 500);
    for (const r of db
      .prepare(`SELECT bizno, loc FROM corp_info WHERE bizno IN (${part.map(() => '?').join(',')}) AND COALESCE(loc, '') <> ''`)
      .all(...part))
      out[r.bizno] = r.loc;
  }
  return out;
}

export function perfTop(q = {}) {
  const w = perfWhere(q);
  w.add("corp_bizno <> ''");
  // limit 0 = 조건에 맞는 업체 전부
  const limit = clampInt(q.limit, 0, 100000, 5) || -1;
  const rows = db
    .prepare(
      `SELECT corp_bizno bizno, corp_nm name, COALESCE(SUM(amt), 0) amt, MAX(rcpt_date) last
         FROM order_latest ${w.clause()} GROUP BY corp_bizno ORDER BY amt DESC, bizno LIMIT ?`
    )
    .all(...w.args, limit);
  const market = db
    .prepare(
      `SELECT COUNT(DISTINCT corp_bizno) corps, COALESCE(SUM(amt), 0) amt FROM order_latest ${w.clause()}`
    )
    .get(...w.args);
  if (limit === -1 && !String(q.rgn || '').trim()) {
    const lw = where();
    dtilWhere(lw, q.fDtil);
    lw.maybe(q.corpLoc, `COALESCE(NULLIF(hdoffce, ''), ci.loc, '') LIKE ?`, like);
    lw.add("COALESCE(corp_bizno, '') <> ''");
    const have = new Set(rows.map((r) => r.bizno));
    const extra = db
      .prepare(
        `SELECT REPLACE(corp_bizno, '-', '') bizno, MAX(corp_nm) name, 0 amt, '' last,
                MAX(COALESCE(NULLIF(hdoffce, ''), ci.loc, '')) loc
           FROM ${LISTING_FROM} ${lw.clause()} GROUP BY 1 ORDER BY COUNT(*) DESC, name`
      )
      .all(...lw.args)
      .filter((r) => !have.has(r.bizno));
    rows.push(...extra);
    market.listedOnly = extra.length;
  }
  return { rows, market };
}

/**
 * 업체별 쇼핑몰 등록품목 수·계약단가 범위 (세부품명 조건 안에서).
 * biznos 가 없으면 조건에 맞는 업체 전부. known: 이 세부품명의 등록품목을 받아 둔 적이 있는지.
 */
function listingOf(q, biznos) {
  const w = where();
  dtilWhere(w, q.fDtil);
  const known = db.prepare(`SELECT 1 FROM product_current ${w.clause()} LIMIT 1`).get(...w.args) != null;
  if (biznos) w.add(`REPLACE(corp_bizno, '-', '') IN (${biznos.map(() => '?').join(',')})`, ...biznos);
  const rows = db
    .prepare(
      `SELECT REPLACE(corp_bizno, '-', '') bizno, COUNT(DISTINCT dtil_clsfc_nm) dtils, COUNT(*) items,
              MIN(price) pmin, MAX(price) pmax
         FROM product_current ${w.clause()} GROUP BY 1`
    )
    .all(...w.args);
  return { known, rows };
}

/** 거래내역이 있는 해 (실적 탭 연도 선택) */
export function orderYears() {
  const r = db.prepare(`SELECT MIN(rcpt_date) a, MAX(rcpt_date) b FROM order_item`).get();
  if (!r.a) return [];
  const out = [];
  for (let y = Number(r.b.slice(0, 4)); y >= Number(r.a.slice(0, 4)); y--) out.push(String(y));
  return out;
}

const PERF_GROUPS = {
  all: `'전체'`,
  year: 'substr(rcpt_date, 1, 4)',
  quarter: "substr(rcpt_date, 1, 4) || 'Q' || ((CAST(substr(rcpt_date, 5, 2) AS INTEGER) + 2) / 3)",
  month: 'substr(rcpt_date, 1, 6)',
  instt: 'dminstt_nm',
  dtil: 'dtil_clsfc_nm',
};

/**
 * 고른 업체들의 실적을 by 기준으로 나눠 업체별로 돌려준다.
 *   by = all | year | quarter | month → 기간 순서대로 모든 구간
 *   by = instt | dtil        → 고른 업체들 합계 기준 상위 limit 개 (limit 0 이면 최대 500)
 */
export function performance(q = {}) {
  // top 이 있으면 조건에 맞는 상위 업체를 여기서 고른다 (0 = 전부) — 업체가 수백 곳이면 주소에 다 싣지 못해서
  const biznos =
    q.top !== undefined && q.top !== ''
      ? perfTop({ ...q, limit: q.top }).rows.map((r) => r.bizno)
      : String(q.biznos || '')
          .split(',')
          .map((s) => s.replace(/[^0-9]/g, ''))
          .filter(Boolean)
          .slice(0, 10); // 업체 실적 탭에서 직접 추가할 수 있는 업체 수 (PERF_CORPS_MAX)
  const allTop = q.top !== undefined && String(q.top) === '0';
  const by = PERF_GROUPS[q.by] ? q.by : 'month';
  if (!biznos.length) return { by, buckets: [], rows: [], corps: [], total: null };
  // scope=all — 업체는 세부품명 조건으로 고르되, 실적은 그 업체들의 모든 세부품명으로 (세부품명 조건만 뺀다)
  const scopeAll = q.scope === 'all' && String(q.fDtil || '').trim() !== '';
  const sq = scopeAll ? { ...q, fDtil: '' } : q;

  const years = perfYears(q);
  // 여러 품목: dtils = JSON 배열 (품목 이름에 쉼표가 들어갈 수 있어서)
  let dtils = [];
  try {
    dtils = q.dtils ? JSON.parse(q.dtils) : [];
  } catch {}
  dtils = (Array.isArray(dtils) ? dtils : []).map(String).slice(0, 50);
  if (!dtils.length && q.dtil) dtils = [String(q.dtil)];
  const cond = (withDtil) => {
    const c = perfWhere(sq, years);
    // 사업자번호는 숫자만 저장돼 있어 색인을 타도록 그대로 비교한다.
    if (allTop && !scopeAll) c.add("corp_bizno <> ''"); // 전부면 조건이 곧 업체 목록이다 — 수천 개 IN 대신
    else if (allTop) c.add('corp_bizno IN (SELECT value FROM json_each(?))', JSON.stringify(biznos)); // 수백 곳이라 값 하나로
    else c.add(`corp_bizno IN (${biznos.map(() => '?').join(',')})`, ...biznos);
    if (withDtil && dtils.length) c.add(`dtil_clsfc_nm IN (${dtils.map(() => '?').join(',')})`, ...dtils);
    return c;
  };
  // split=dtil 이면 구간 × 업체 × 품목으로 나눠 돌려준다 (품목별 계열)
  const split = q.split === 'dtil' && by !== 'dtil';
  // 업체별 요약(corps)은 품목과 관계없이 전체로 내고, 구간별 금액은 고른 세부품명(dtil)이 있으면 그 품목만.
  const all = cond(false);
  const w = cond(true);
  const expr = PERF_GROUPS[by];

  const corps = db
    .prepare(
      `SELECT REPLACE(corp_bizno, '-', '') bizno, corp_nm name, MAX(rcpt_date) last,
              COUNT(*) cnt, COALESCE(SUM(amt), 0) amt, COUNT(DISTINCT dlvr_req_no) reqs,
              COUNT(DISTINCT dminstt_nm) instts
         FROM order_latest ${all.clause()} GROUP BY REPLACE(corp_bizno, '-', '')`
    )
    .all(...all.args);
  // 고른 업체 전체 합계 (기관 수 등은 업체별 값을 더하면 겹치므로 따로 센다)
  const total = db
    .prepare(
      `SELECT MAX(rcpt_date) last, COUNT(*) cnt, COALESCE(SUM(amt), 0) amt,
              COUNT(DISTINCT dlvr_req_no) reqs, COUNT(DISTINCT dminstt_nm) instts
         FROM order_latest ${all.clause()}`
    )
    .get(...all.args);

  let buckets;
  if (by === 'instt' || by === 'dtil') {
    const limit = clampInt(q.limit, 0, 500, 10) || 500;
    buckets = db
      .prepare(
        `SELECT ${expr} b FROM order_latest ${w.clause()}
          GROUP BY b ORDER BY SUM(amt) DESC LIMIT ?`
      )
      .all(...w.args, limit)
      .map((r) => r.b ?? '');
  } else {
    buckets = db
      .prepare(`SELECT DISTINCT ${expr} b FROM order_latest ${w.clause()} ORDER BY b`)
      .all(...w.args)
      .map((r) => r.b ?? '');
    // 거래가 없던 달·해도 빈 칸으로 넣어, 막대 사이 간격이 실제 시간 간격이 되게 한다.
    if ((by === 'month' || by === 'quarter' || by === 'year') && buckets.length > 1) buckets = fillPeriods(by, buckets[0], buckets.at(-1));
    // 떨어진 해를 골랐으면 고르지 않은 해의 빈 칸은 뺀다.
    if (years.length) buckets = buckets.filter((b) => b === '전체' || years.includes(String(b).slice(0, 4)));
  }

  const rows = db
    .prepare(
      `SELECT ${expr} bucket, REPLACE(corp_bizno, '-', '') bizno, ${split ? 'dtil_clsfc_nm dtil,' : ''}
              COALESCE(SUM(amt), 0) amt,
              COUNT(*) cnt, COUNT(DISTINCT dlvr_req_no) reqs, COALESCE(SUM(qty), 0) qty,
              COUNT(DISTINCT dminstt_nm) instts, MAX(rcpt_date) last
         FROM order_latest ${w.clause()} GROUP BY bucket, bizno${split ? ', dtil' : ''}`
    )
    .all(...w.args);
  const keep = new Set(buckets);
  const listing = q.listing ? listingOf(sq, allTop && !scopeAll ? null : biznos) : undefined;
  // 전체 품목으로 볼 때, 검색한 세부품명 조건에 드는 품목 (표에서 ★ 로 표시)
  let condDtils;
  if (scopeAll && by === 'dtil' && buckets.length) {
    const cw = dtilWhere(where(), q.fDtil);
    condDtils = db
      .prepare(`SELECT dtil_clsfc_nm d FROM (SELECT value dtil_clsfc_nm FROM json_each(?)) ${cw.clause()}`)
      .all(JSON.stringify(buckets.filter(Boolean)), ...cw.args)
      .map((r) => r.d);
  }
  // 업체소재지 (거래내역에는 없어 corp_info 에서) — 품목 목록을 같이 달라는 호출에만 싣는다
  const locs = q.listing ? corpLocs(allTop ? corps.map((c) => c.bizno) : biznos) : undefined;
  return { by, buckets, rows: rows.filter((r) => keep.has(r.bucket ?? '')), corps, total, listing, locs, condDtils };
}

/**
 * 등록품목 현황 숫자 — product_current 로 세면 100만 줄(쇼핑몰 전체 등록 내역 파일)에서 2분 넘게 걸려
 * 화면을 열 때마다 서버가 멈춘다. 계약 끝난·내려간 품목만 빼고 바로 세며(계약 변경 전 옛 버전 몇천 줄이 더 세어짐),
 * 5분 동안은 센 값을 다시 쓴다.
 */
let productCounts = null;
function productOverview() {
  if (productCounts && Date.now() - productCounts.at < 5 * 60e3) return productCounts.v;
  const live = `FROM product WHERE COALESCE(delisted, 0) = 0
     AND (COALESCE(cntrct_end, '') = '' OR cntrct_end >= strftime('%Y%m%d', 'now', '+9 hours'))`;
  const byDataset = db.prepare(`SELECT dataset, COUNT(*) c ${live} GROUP BY dataset ORDER BY c DESC`).all();
  const p = db.prepare(`SELECT COUNT(DISTINCT corp_nm) corps, MIN(NULLIF(rgst_date,'')) f, MAX(rgst_date) t ${live}`).get();
  const v = { count: byDataset.reduce((a, r) => a + r.c, 0), corps: p.corps, from: p.f, to: p.t, byDataset };
  productCounts = { at: Date.now(), v };
  return v;
}

export function overview() {
  const o = db
    .prepare(
      `SELECT COUNT(*) c, COALESCE(SUM(amt),0) amt, COUNT(DISTINCT dminstt_nm) instts,
              COUNT(DISTINCT corp_nm) corps, MIN(NULLIF(rcpt_date,'')) f, MAX(rcpt_date) t
         FROM order_latest`
    )
    .get();
  const h = db.prepare('SELECT COUNT(*) c FROM order_head').get();

  const mine = (() => {
    const w = orderWhere({ mine: true });
    if (!myCorps().length) return null;
    return db
      .prepare(
        `SELECT COUNT(*) c, COALESCE(SUM(amt),0) amt, COUNT(DISTINCT dminstt_nm) instts,
                MAX(rcpt_date) t FROM order_latest ${w.clause()}`
      )
      .get(...w.args);
  })();

  return {
    product: productOverview(),
    orderItem: { count: o.c, amount: o.amt, institutions: o.instts, corps: o.corps, from: o.f, to: o.t },
    orderHead: { count: h.c },
    mine,
  };
}

/* ── 북마크 ───────────────────────────────────────────────────────── */

export function listBookmarks() {
  return db.prepare('SELECT * FROM bookmark ORDER BY id DESC').all();
}

export function addBookmark({ kind, refKey, title, subtitle, payload, memo }) {
  db.prepare(
    `INSERT INTO bookmark(kind, ref_key, title, subtitle, payload, memo, created_at)
     VALUES(?,?,?,?,?,?,?)
     ON CONFLICT(kind, ref_key) DO UPDATE SET title=excluded.title, subtitle=excluded.subtitle,
       payload=excluded.payload, memo=excluded.memo`
  ).run(
    String(kind),
    String(refKey),
    String(title || ''),
    String(subtitle || ''),
    JSON.stringify(payload ?? null),
    String(memo || ''),
    new Date().toISOString()
  );
  return listBookmarks();
}

export function removeBookmark(id) {
  db.prepare('DELETE FROM bookmark WHERE id = ?').run(Number(id));
  return listBookmarks();
}

/* ── 물품비교 (관심목록에서 고른 물품) ─────────────────────────────── */

/**
 * 관심목록 id 들을 받아 물품마다 한 칸씩 — 등록품목 정보 + 그 물품(같은 식별번호·같은 업체)의 실거래.
 *   product 북마크: ref_key = 계약번호-물품식별번호
 *   order   북마크: ref_key = 납품요구번호-품목순번 → 그 거래의 식별번호·업체로 등록품목을 찾는다
 * 등록품목이 없으면(쇼핑몰에서 내려감 등) 거래 줄의 정보로 채운다.
 */
export function compareItems(ids, { withDeals = true } = {}) {
  const list = String(ids || '')
    .split(',')
    .map(Number)
    .filter((v) => Number.isInteger(v) && v > 0)
    .slice(0, withDeals ? 12 : 2000);
  const getMark = db.prepare('SELECT * FROM bookmark WHERE id = ?');
  const LOC = `COALESCE(NULLIF(p.hdoffce, ''), ci.loc, '')`;
  const prodBy = (where, ...args) =>
    db
      .prepare(
        // live = product_current 와 같은 기준 (보기를 거치면 느려서 그대로 풀어 쓴다)
        `SELECT p.*, ${LOC} corp_loc,
                (COALESCE(p.delisted, 0) = 0
                 AND (COALESCE(p.cntrct_end, '') = '' OR p.cntrct_end >= strftime('%Y%m%d', 'now', '+9 hours'))
                 AND NOT EXISTS (
                   SELECT 1 FROM product n
                    WHERE n.dataset = p.dataset AND n.prdct_idnt_no = p.prdct_idnt_no
                      AND COALESCE(n.corp_bizno, '') = COALESCE(p.corp_bizno, '') AND COALESCE(n.delisted, 0) = 0
                      AND (COALESCE(n.rgst_date, ''), n.cntrct_no, n.cntrct_sno) > (COALESCE(p.rgst_date, ''), p.cntrct_no, p.cntrct_sno))) live
           FROM product p LEFT JOIN corp_info ci ON ci.bizno = REPLACE(p.corp_bizno, '-', '')
          WHERE ${where} ORDER BY live DESC, p.rgst_date DESC LIMIT 1`
      )
      .get(...args);
  const deals = db.prepare(
    `SELECT COUNT(DISTINCT dlvr_req_no) reqs, COALESCE(SUM(amt), 0) amt, COALESCE(SUM(qty), 0) qty,
            MIN(uprc) umin, MAX(uprc) umax, MAX(rcpt_date) last, COUNT(DISTINCT dminstt_nm) instts
       FROM order_latest WHERE prdct_idnt_no = ? AND corp_bizno = ? AND qty > 0`
  );
  const orderRow = db.prepare(
    `SELECT o.*, (SELECT loc FROM corp_info ci WHERE ci.bizno = o.corp_bizno) corp_loc
       FROM order_latest o WHERE dlvr_req_no = ? AND prdct_sno = ?`
  );

  return list.map((id) => {
    const m = getMark.get(id);
    if (!m) return { id, missing: '관심목록에서 지워졌습니다.' };
    const cut = m.ref_key.lastIndexOf('-');
    const [a, b] = [m.ref_key.slice(0, cut), m.ref_key.slice(cut + 1)];
    let p = null;
    let o = null;
    if (m.kind === 'product') p = prodBy('p.cntrct_no = ? AND p.prdct_idnt_no = ?', a, b);
    else if (m.kind === 'order') {
      o = orderRow.get(a, b);
      if (o) p = prodBy(`p.prdct_idnt_no = ? AND REPLACE(p.corp_bizno, '-', '') = ?`, o.prdct_idnt_no, o.corp_bizno);
    }
    if (!p && !o) return { id, kind: m.kind, title: m.title, memo: m.memo, missing: '저장된 자료에서 찾지 못했습니다.' };
    const idnt = p?.prdct_idnt_no || o.prdct_idnt_no;
    const bizno = String(p?.corp_bizno || o.corp_bizno || '').replace(/[^0-9]/g, '');
    const d = withDeals ? deals.get(idnt, bizno) : null;
    const pick = (k, ok = k) => p?.[k] ?? o?.[ok] ?? '';
    return {
      id,
      kind: m.kind,
      memo: m.memo || '',
      listed: Boolean(p?.live),
      delisted: Boolean(p) && !p.live,
      img_url: p?.img_url || '',
      dtil_clsfc_nm: pick('dtil_clsfc_nm'),
      prdct_clsfc_nm: pick('prdct_clsfc_nm'),
      spec_nm: pick('spec_nm'),
      prdct_idnt_no: idnt,
      corp_nm: pick('corp_nm'),
      corp_bizno: bizno,
      corp_loc: pick('corp_loc'),
      entrprs_div: p?.entrprs_div || '',
      makr_nm: p?.makr_nm || '',
      price: p?.price ?? null,
      unit: pick('unit'),
      cntrct_bgn: p?.cntrct_bgn || '',
      cntrct_end: p?.cntrct_end || '',
      cntrct_mthd: p?.cntrct_mthd || '',
      mas_yn: pick('mas_yn') ? 1 : 0,
      exclc_yn: pick('exclc_yn') ? 1 : 0,
      smetpr_yn: pick('smetpr_yn') ? 1 : 0,
      cert_list: p?.cert_list || '',
      dlvr_days: p?.dlvr_days || null,
      sply_rgn: p?.sply_rgn || '',
      orgplce: p?.orgplce || '',
      rgst_date: p?.rgst_date || '',
      created_at: m.created_at,
      deals: d ? { ...d, avg: d.qty ? Math.round(d.amt / d.qty) : null } : null,
    };
  });
}

/** 물품비교에서 고를 목록 — 관심목록의 물품 전부 (사진·업체·단가, 실거래는 빼고) */
export function comparePickList() {
  const ids = db.prepare(`SELECT id FROM bookmark WHERE kind IN ('product', 'order') ORDER BY id DESC`).all().map((r) => r.id);
  return compareItems(ids.join(','), { withDeals: false });
}

/* ── CSV 내보내기 ─────────────────────────────────────────────────── */

const CSV_HEADERS = {
  orders: [
    ['rcpt_date', '납품요구일'],
    ['dlvr_req_no', '납품요구번호'],
    ['dlvr_req_nm', '납품요구건명'],
    ['dminstt_nm', '수요기관'],
    ['dminstt_div', '기관구분'],
    ['dminstt_rgn', '기관지역'],
    ['corp_nm', '업체명'],
    ['corp_bizno', '사업자번호'],
    ['corp_loc', '업체소재지'],
    ['prdct_clsfc_nm', '품명'],
    ['dtil_clsfc_nm', '세부품명'],
    ['spec_nm', '물품규격명'],
    ['prdct_idnt_no', '물품식별번호'],
    ['uprc', '단가'],
    ['qty', '수량'],
    ['unit', '단위'],
    ['amt', '금액'],
    ['cncls_stle', '계약체결형태'],
    ['dlvr_tmlmt', '납품기한'],
  ],
  products: [
    ['rgst_date', '등록일'],
    ['dataset', '구분'],
    ['cntrct_no', '쇼핑계약번호'],
    ['prdct_clsfc_nm', '품명'],
    ['dtil_clsfc_nm', '세부품명'],
    ['spec_nm', '규격'],
    ['prdct_idnt_no', '물품식별번호'],
    ['corp_nm', '계약업체'],
    ['corp_bizno', '사업자번호'],
    ['corp_loc', '업체소재지'],
    ['entrprs_div', '기업구분'],
    ['cntrct_mthd', '계약방법'],
    ['price', '계약단가'],
    ['unit', '단위'],
    ['makr_nm', '제조사'],
    ['orgplce', '원산지'],
    ['cntrct_end', '계약종료일'],
  ],
};

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function toCsv(kind, rows, cols = CSV_HEADERS[kind] || Object.keys(rows[0] || {}).map((k) => [k, k])) {
  const head = cols.map(([, label]) => csvCell(label)).join(',');
  const body = rows.map((r) => cols.map(([key]) => csvCell(r[key])).join(',')).join('\n');
  // 엑셀에서 한글이 깨지지 않도록 BOM 을 붙인다.
  return '﻿' + head + '\n' + body + '\n';
}
