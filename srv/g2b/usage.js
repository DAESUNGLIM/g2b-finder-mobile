/**
 * 하루 API 호출 횟수 집계.
 *
 * 개발계정 트래픽이 하루 1,000건이라 "몇 번 남았는지" 를 화면에 보여줘야
 * 사용자가 수집 범위를 조절할 수 있다. 호출 직전에 센다.
 *
 * 한도는 **서비스마다 따로** 주어진다(각각 따로 활용신청한 별개의 API 다).
 * 그래서 합계가 아니라 서비스별로 세야 한다 — 업체소재지를 700번 채운 날에도
 * 쇼핑몰 수집 한도는 그대로 남아 있다.
 */

/** 오퍼레이션 이름으로 어느 서비스인지 가른다 (이름이 서비스마다 겹치지 않는다). */
export const API_SERVICES = [
  {
    id: 'shop',
    label: '종합쇼핑몰 품목정보',
    test: (op) => /^(getShoppingMall|getDlvrReq|getMASCntrct|getUcntrct|getThptyUcntrct)/.test(op),
  },
  { id: 'usr', label: '나라장터 사용자정보', test: (op) => /^getPrcrmnt/.test(op) },
  { id: 'thng', label: '물품목록정보', test: (op) => /^getPrdctClsfcNo/.test(op) },
];

/** 모르는 오퍼레이션은 주된 서비스(쇼핑몰)로 본다 — 한도를 넉넉히 잡는 쪽이 아니라 빡빡하게 잡는 쪽. */
export const serviceOf = (operation) =>
  (API_SERVICES.find((s) => s.test(String(operation || ''))) || API_SERVICES[0]).id;

let sink = null;

/** db.js 가 준비되면 실제 기록 함수를 꽂아준다. */
export function setUsageSink(fn) {
  sink = fn;
}

export function recordApiCall(operation) {
  if (!sink) return;
  try {
    sink(operation);
  } catch {
    // 집계 실패가 본 호출을 막으면 안 된다.
  }
}
