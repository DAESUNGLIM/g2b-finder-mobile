/**
 * 현황 화면의 숫자 세기 — PC 는 뒤에서(ovwork.js), 휴대폰은 바로(search.js) 이 함수를 부른다.
 *
 * 거래내역이 1천만 줄을 넘으면 예전처럼 표를 통째로 읽어 세는 데 2분 넘게 걸린다. 그래서 색인만 읽고 센다:
 *   건수·금액   건(납품요구번호+물품순번)마다 가장 최신 변경차수 한 줄 — idx_oi_sum 에 금액까지 있어 표를 읽지 않는다
 *   기간        접수일 색인의 처음·끝
 *   기관·업체   이름 색인에서 이름을 하나씩 건너뛰며 센다 (변경 전 차수에만 나온 이름도 세지만, 같은 건은 차수가 달라도 기관·업체가 같다)
 * 등록품목은 계약 끝난·내려간 품목만 빼고 바로 센다 (계약 변경 전 옛 버전 몇천 줄이 더 세어진다 — product_current 로 세면 몇 배 걸린다).
 *
 * 이 파일은 아무것도 불러오지 않는다 — db.js 를 불러오면 뒤에서 세는 쪽에서도 서버용 표 만들기가 따라 돈다.
 * @param db prepare() 가 있는 DB (node:sqlite 또는 휴대폰의 것)
 */
export function countOverview(db) {
  const live = `FROM product WHERE COALESCE(delisted, 0) = 0
     AND (COALESCE(cntrct_end, '') = '' OR cntrct_end >= strftime('%Y%m%d', 'now', '+9 hours'))`;
  const byDataset = db.prepare(`SELECT dataset, COUNT(*) c ${live} GROUP BY dataset ORDER BY c DESC`).all();
  const p = db.prepare(`SELECT COUNT(DISTINCT corp_nm) corps, MIN(NULLIF(rgst_date,'')) f, MAX(rgst_date) t ${live}`).get();

  // MAX(chg_ord) 와 같이 고른 amt 는 그 최신 줄의 금액이다. 바깥에서 m 을 써야 안쪽의 MAX 가 빠지지 않는다.
  const o = db
    .prepare(
      `SELECT COUNT(m) c, COALESCE(SUM(amt), 0) amt
         FROM (SELECT amt, MAX(chg_ord) m FROM order_item GROUP BY dlvr_req_no, prdct_sno)`
    )
    .get();
  const d = db.prepare(`SELECT (SELECT MIN(rcpt_date) FROM order_item WHERE rcpt_date > '') f, (SELECT MAX(rcpt_date) FROM order_item) t`).get();
  const names = (col) =>
    db
      .prepare(
        `WITH RECURSIVE t(x) AS (
           SELECT MIN(${col}) FROM order_item WHERE ${col} > ''
           UNION ALL
           SELECT (SELECT MIN(${col}) FROM order_item WHERE ${col} > t.x) FROM t WHERE t.x IS NOT NULL
         ) SELECT COUNT(x) n FROM t`
      )
      .get().n;
  const h = db.prepare('SELECT COUNT(*) c FROM order_head').get();

  return {
    product: { count: byDataset.reduce((a, r) => a + r.c, 0), corps: p.corps, from: p.f, to: p.t, byDataset },
    orderItem: { count: o.c, amount: o.amt, institutions: names('dminstt_nm'), corps: names('corp_nm'), from: d.f, to: d.t },
    orderHead: { count: h.c },
  };
}
