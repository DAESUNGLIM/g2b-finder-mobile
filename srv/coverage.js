/**
 * 수집 범위(coverage) 관리 — "어느 날짜를 이미 받아 뒀나".
 *
 * 수집이 한 구간을 끝까지(마지막 페이지까지) 받으면 그 구간의 날짜를 전부 기록한다.
 * 다음 수집·검색은 기록이 없는 날짜만 API 로 받는다.
 *
 * 최근 날짜 규칙
 *   조달청은 "하루 전 자료" 까지 주고, 늦게 반영되는 건이 있다.
 *   그래서 D 일 자료는 D+2 일 이후에 받은 것만 "확정" 으로 본다.
 *   그보다 일찍 받았으면 오늘 한 번 받은 것은 인정하고, 다음 날 한 번 더 받는다.
 */

import { db, today } from './db.js';
import { isMock } from './config.js';
import { DATASETS } from './g2b/spec.js';

/**
 * 샘플 모드에서 받은 날짜 기록은 실제 모드에서 인정하지 않는다.
 * (섞이면 인증키를 넣은 뒤에도 그 날짜의 실제 자료를 건너뛰게 된다)
 */
const SAMPLE = '@sample';
const covId = (datasetId) => (isMock() ? datasetId + SAMPLE : datasetId);

const toDate = (ymd) =>
  new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)));
const toYmd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
export const addDays = (ymd, n) => toYmd(new Date(toDate(ymd).getTime() + n * 86400000));

/** 한국시간 오늘 / 어제 (YYYYMMDD) */
export const todayYmd = () => today().replace(/-/g, '');
export const yesterdayYmd = () => addDays(todayYmd(), -1);

export function daysBetween(bgn, end) {
  const out = [];
  for (let d = bgn; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

/** API 로 넘기는 필터를 정렬된 문자열 하나로. 필터 없이 전체를 받았으면 '' */
export function filterKey(ds, filters) {
  return Object.entries(filters || {})
    .filter(([k, v]) => ds.filters.includes(k) && String(v ?? '').trim())
    .map(([k, v]) => `${k}=${String(v).trim()}`)
    .sort()
    .join('&');
}

/** 전체('')를 받았으면 어떤 필터 조건도 만족한다. */
export const acceptKeys = (key) => (key ? ['', key] : ['']);

/**
 * 등록품목은 받은 뒤에도 품목이 내려가거나 바뀐다. 그래서 받은 지 이 일수가 지나면
 * 다시 받아야 할 날짜로 본다 (다시 받을 때 사라진 품목을 "내려감" 으로 표시한다).
 */
const PRODUCT_TTL_DAYS = 30;

function isFresh(day, fetchedDay, now, isProduct = false) {
  if (isProduct && fetchedDay < addDays(now, -PRODUCT_TTL_DAYS)) return false;
  return fetchedDay === now || fetchedDay > addDays(day, 1);
}

/**
 * [bgn, end] 가운데 아직 없는(또는 다시 받아야 할) 날짜.
 * 종료일은 어제로 자른다 — 오늘 자료는 API 에 아직 없다.
 */
export function missingDays(datasetId, bgn, end, keys = ['']) {
  const last = end > yesterdayYmd() ? yesterdayYmd() : end;
  if (bgn > last) return { from: bgn, to: last, total: 0, days: [] };

  const ph = keys.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT day, MAX(fetched_day) fetched FROM coverage
        WHERE dataset = ? AND filter_key IN (${ph}) AND day BETWEEN ? AND ?
        GROUP BY day`
    )
    .all(covId(datasetId), ...keys, bgn, last);

  const have = new Map(rows.map((r) => [r.day, r.fetched]));
  const now = todayYmd();
  const all = daysBetween(bgn, last);
  const isProduct = DATASETS[datasetId]?.kind === 'product';
  const days = all.filter((d) => !(have.has(d) && isFresh(d, have.get(d), now, isProduct)));
  return { from: bgn, to: last, total: all.length, days };
}

/** 날짜 목록을 연속 구간으로 묶고, 한 구간이 maxLen 일을 넘지 않게 자른다. */
export function toRanges(days, maxLen = 31) {
  const out = [];
  for (const d of days) {
    const cur = out[out.length - 1];
    if (cur && addDays(cur.end, 1) === d && cur.len < maxLen) {
      cur.end = d;
      cur.len++;
    } else {
      out.push({ bgn: d, end: d, len: 1 });
    }
  }
  return out.map(({ bgn, end }) => ({ bgn, end }));
}

const upsertCov = db.prepare(
  `INSERT INTO coverage(dataset, filter_key, day, fetched_day, rows) VALUES(?,?,?,?,?)
   ON CONFLICT(dataset, filter_key, day) DO UPDATE SET
     fetched_day = MAX(fetched_day, excluded.fetched_day), rows = excluded.rows`
);

/**
 * 끝까지 받은 구간을 기록한다. rows 는 날짜별 평균(호출 수 추정용).
 * 파일 가져오기는 fetchedDay 에 파일 출력일을 넘긴다 — 최근 날짜 규칙을 파일에도 똑같이 적용하려고.
 * 파일 자료는 실제 자료이므로 샘플 모드여도 실제 기록(real)으로 남긴다.
 */
export function markCovered(datasetId, key, bgn, end, rows, { fetchedDay, real = false } = {}) {
  const days = daysBetween(bgn, end);
  const per = Math.round(rows / Math.max(1, days.length));
  const now = fetchedDay || todayYmd();
  const id = real ? datasetId : covId(datasetId);
  for (const d of days) upsertCov.run(id, key, d, now, per);
}

/**
 * 빠진 날짜를 받는 데 API 가 몇 번쯤 필요할지.
 * 이전에 받은 날들의 하루 평균 건수로 어림한다. 기록이 없으면 null.
 */
export function estimateCalls(datasetId, dayCount, numOfRows, chunkDays, key = '') {
  if (!dayCount) return 0;
  const r = db
    .prepare(`SELECT AVG(rows) avg, COUNT(*) n FROM coverage WHERE dataset = ? AND filter_key = ?`)
    .get(covId(datasetId), key);
  // 세부품명으로 좁혀 받는 경우는 대개 구간당 한 페이지면 끝난다.
  if (!r.n) return key ? Math.ceil(dayCount / chunkDays) : null;
  const perChunk = Math.max(1, Math.ceil((r.avg * Math.min(chunkDays, dayCount)) / numOfRows));
  return Math.ceil(dayCount / chunkDays) * perChunk;
}

/** 현황 화면용 요약 */
export function coverageSummary() {
  return db
    .prepare(
      `SELECT REPLACE(dataset, '${SAMPLE}', '') dataset, COUNT(DISTINCT day) days,
              MIN(day) from_day, MAX(day) to_day
         FROM coverage
        WHERE filter_key = '' AND (dataset LIKE '%${SAMPLE}') = ?
        GROUP BY dataset`
    )
    .all(isMock() ? 1 : 0);
}
