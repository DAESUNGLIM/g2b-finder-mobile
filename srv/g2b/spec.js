/**
 * 나라장터쇼핑몰 품목정보서비스의 오퍼레이션 정의.
 *
 * 한 오퍼레이션 = 하나의 "데이터셋". 화면·수집·저장이 모두 이 표를 보고 움직인다.
 *
 * kind 세 가지
 *   product   : 쇼핑몰에 등록된 물품 (계약단가·규격·업체)
 *   orderHead : 납품요구서 1건 (거래 헤더)
 *   orderItem : 납품요구서 안의 물품 1줄 (실제 거래내역 — 단가·수량·금액)
 *
 * 날짜 파라미터는 오퍼레이션마다 이름과 자릿수가 다르다.
 *   *Date (조회기준일자)  -> YYYYMMDD
 *   *Dt   (등록/변경일시) -> YYYYMMDDHHMM
 * 조달청 쪽에서 다르게 받는 경우가 있어 dateFormats 에 후보를 순서대로 적어두고
 * 파라미터 오류(코드 10/11)가 나면 다음 후보로 자동 재시도한다. (collect.js)
 */

const YN = (v) => (String(v ?? '').trim().toUpperCase() === 'Y' ? 1 : 0);

const num = (v) => {
  const n = Number(String(v ?? '').replace(/[,\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

const str = (v) => {
  const s = String(v ?? '').trim();
  return s === 'null' || s === 'undefined' ? '' : s;
};

/** 날짜/일시 값에서 숫자만 뽑아 앞 8자리(YYYYMMDD)를 쓴다. */
const day = (v) => str(v).replace(/[^0-9]/g, '').slice(0, 8);

/** 품목 계열 오퍼레이션은 응답 필드가 거의 같아서 정규화를 공유한다. */
function normalizeProduct(r) {
  return {
    cntrct_no: str(r.shopngCntrctNo),
    cntrct_sno: str(r.shopngCntrctSno),
    prdct_idnt_no: str(r.prdctIdntNo),
    prdct_clsfc_no: str(r.prdctClsfcNo),
    prdct_clsfc_nm: str(r.prdctClsfcNoNm),
    dtil_clsfc_no: str(r.dtilPrdctClsfcNo),
    dtil_clsfc_nm: str(r.dtilPrdctClsfcNoNm),
    spec_nm: str(r.prdctSpecNm) || str(r.prdctIdntNoNm),
    corp_nm: str(r.cntrctCorpNm),
    corp_bizno: str(r.cntrctCorpBizno) || str(r.cntrctCorpNo),
    entrprs_div: str(r.entrprsDivNm),
    cntrct_mthd: str(r.cntrctMthdNm),
    price: num(r.cntrctPrceAmt),
    order_price: num(r.orderCalclPrceAmt),
    unit: str(r.prdctUnit),
    makr_nm: str(r.prdctMakrNm),
    orgplce: str(r.prdctOrgplceNm),
    sply_rgn: str(r.prdctSplyRgnNm),
    dlvr_days: num(r.dlvrTmlmtDaynum),
    mas_yn: YN(r.masYn),
    exclc_yn: YN(r.exclncPrcrmntPrdctYn ?? r.exclcProdctYn),
    smetpr_yn: YN(r.smetprCmptProdctYn),
    cert_list: str(r.prodctCertList),
    img_url: str(r.prdctImgUrl),
    hdoffce: str(r.hdoffceLocplc),
    fctry: str(r.fctryLocplc),
    cntrct_date: day(r.cntrctDate),
    cntrct_bgn: day(r.cntrctBgnDate),
    cntrct_end: day(r.cntrctEndDate),
    rgst_date: day(r.rgstDt),
  };
}

/** 품목 계열 공통 조회구분 후보 */
const DIV_PRODUCT = [
  { value: '1', label: '조회기간(등록일시) 기준' },
  { value: '2', label: '조회기간(변경일시) 기준' },
  { value: '3', label: '물품식별번호 기준' },
];

/** 납품요구 계열 공통 조회구분 후보 */
const DIV_ORDER = [
  { value: '1', label: '납품요구접수일자 기준' },
  { value: '2', label: '납품요구번호 기준' },
  { value: '3', label: '계약번호 기준' },
];

export const DATASETS = {
  dlvrDtl: {
    id: 'dlvrDtl',
    label: '납품요구 상세 (거래내역)',
    hint: '수요기관이 쇼핑몰에서 사 간 물품을 한 줄씩. 단가·수량·금액이 들어 있어 실적 집계의 기준입니다.',
    operation: 'getDlvrReqDtlInfoList',
    kind: 'orderItem',
    dateParams: { bgn: 'inqryBgnDate', end: 'inqryEndDate' },
    dateFormats: ['ymd', 'ymdhm'],
    inqryDivs: DIV_ORDER,
    filters: ['dlvrReqNo', 'cntrctNo', 'prdctClsfcNoNm', 'dtilPrdctClsfcNoNm', 'prdctIdntNoNm'],
    normalize: (r) => ({
      dlvr_req_no: str(r.dlvrReqNo),
      chg_ord: str(r.dlvrReqChgOrd) || '0',
      prdct_sno: str(r.prdctSno) || '0',
      rcpt_date: day(r.dlvrReqRcptDate),
      dlvr_req_nm: str(r.dlvrReqNm),
      cntrct_no: str(r.cntrctNo),
      cntrct_chg_ord: str(r.cntrctChgOrd),
      corp_nm: str(r.corpNm),
      corp_bizno: str(r.cntrctCorpBizno),
      corp_div: str(r.corpEntrprsDivNmNm),
      dminstt_cd: str(r.dminsttCd),
      dminstt_nm: str(r.dminsttNm),
      dminstt_div: str(r.dmndInsttDivNm),
      dminstt_rgn: str(r.dminsttRgnNm),
      prdct_clsfc_no: str(r.prdctClsfcNo),
      prdct_clsfc_nm: str(r.prdctClsfcNoNm),
      dtil_clsfc_no: str(r.dtilPrdctClsfcNo),
      dtil_clsfc_nm: str(r.dtilPrdctClsfcNoNm),
      prdct_idnt_no: str(r.prdctIdntNo),
      spec_nm: str(r.prdctIdntNoNm),
      uprc: num(r.prdctUprc),
      qty: num(r.prdctQty),
      unit: str(r.prdctUnit),
      amt: num(r.prdctAmt),
      incdec_qty: num(r.incdecQty),
      incdec_amt: num(r.incdecAmt),
      dlvr_tmlmt: day(r.dlvrTmlmtDate),
      cncls_stle: str(r.cntrctCnclsStleNm),
      mas_yn: YN(r.masYn),
      exclc_yn: YN(r.exclcProdctYn),
      smetpr_yn: YN(r.smetprCmptProdctYn),
      cnstwk_mtrl_yn: YN(r.cnstwkMtrlDrctPurchsObjYn),
      fnl_yn: YN(r.fnlDlvrReqYn),
      optn_div: str(r.optnDivCdNm),
      brnofce: str(r.brnofceNm),
    }),
  },

  dlvr: {
    id: 'dlvr',
    label: '납품요구 현황 (건별)',
    hint: '납품요구서 한 건 단위의 요약. 총 금액과 대표품명만 필요할 때 씁니다.',
    operation: 'getDlvrReqInfoList',
    kind: 'orderHead',
    dateParams: { bgn: 'inqryBgnDate', end: 'inqryEndDate' },
    dateFormats: ['ymd', 'ymdhm'],
    inqryDivs: DIV_ORDER,
    filters: ['dlvrReqNo', 'cntrctNo', 'dminsttCd', 'dminsttNm'],
    normalize: (r) => ({
      dlvr_req_no: str(r.dlvrReqNo),
      chg_ord: str(r.dlvrReqChgOrd) || '0',
      rcpt_date: day(r.dlvrReqRcptDate),
      dlvr_req_nm: str(r.dlvrReqNm),
      cntrct_no: str(r.cntrctNo),
      cntrct_chg_ord: str(r.cntrctChgOrd),
      corp_nm: str(r.corpNm),
      corp_bizno: str(r.corpBizno),
      corp_div: str(r.corpEntrprsDivNm),
      dminstt_cd: str(r.dminsttCd),
      dminstt_nm: str(r.dminsttNm),
      dminstt_div: str(r.dmndInsttDivNm),
      dminstt_rgn: str(r.dminsttRgnNm),
      qty: num(r.dlvrReqQty),
      amt: num(r.dlvrReqAmt),
      incdec_qty: num(r.dlvrReqIncdecQty ?? r.incdecQty),
      incdec_amt: num(r.dlvrReqIncdecAmt),
      rprsnt_clsfc_nm: str(r.rprsntPrdctClsfcNoNm),
      rprsnt_dtil_nm: str(r.rprsntDtilPrdctClsfcNoNm),
      max_dlvr_tmlmt: day(r.maxDlvrTmlmtDate),
      cncls_stle: str(r.cntrctCnclsStleNm),
      mas_yn: YN(r.masYn),
      exclc_yn: YN(r.exclcProdctYn),
      fnl_yn: YN(r.fnlDlvrReqYn),
    }),
  },

  shop: {
    id: 'shop',
    label: '쇼핑몰 등록품목',
    hint: '나라장터쇼핑몰에 등록된 전체 품목. 품명·세부품명·규격으로 찾습니다.',
    operation: 'getShoppingMallPrdctInfoList',
    kind: 'product',
    dateParams: { bgn: 'inqryBgnDate', end: 'inqryEndDate' },
    dateFormats: ['ymd', 'ymdhm'],
    inqryDivs: [
      { value: '1', label: '조회기간(등록일자) 기준' },
      { value: '2', label: '품명 기준' },
      { value: '3', label: '세부품명 기준' },
      { value: '4', label: '물품규격명 기준' },
    ],
    filters: [
      'prdctClsfcNoNm',
      'dtilPrdctClsfcNoNm',
      'prdctIdntNoNm',
      'shopngCntrctNo',
      'masYn',
      'exclcProdctYn',
      'prodctCertYn',
      'regtCncelYn',
    ],
    normalize: normalizeProduct,
  },

  mas: {
    id: 'mas',
    label: '다수공급자계약(MAS) 품목',
    hint: '2인 이상과 맺는 MAS 계약 품목. 계약조건·인증·원산지까지 들어 있습니다.',
    operation: 'getMASCntrctPrdctInfoList',
    kind: 'product',
    dateParams: { bgn: 'rgstDtBgnDt', end: 'rgstDtEndDt' },
    dateFormats: ['ymdhm', 'ymd'],
    inqryDivs: DIV_PRODUCT,
    filters: ['prdctClsfcNoNm', 'prdctIdntNo', 'cntrctCorpNm', 'prodctCertYn'],
    normalize: normalizeProduct,
  },

  ucntrct: {
    id: 'ucntrct',
    label: '일반단가계약 품목',
    hint: '조달청이 직접 맺은 일반단가계약 품목입니다.',
    operation: 'getUcntrctPrdctInfoList',
    kind: 'product',
    dateParams: { bgn: 'rgstDtBgnDt', end: 'rgstDtEndDt' },
    dateFormats: ['ymdhm', 'ymd'],
    inqryDivs: DIV_PRODUCT,
    filters: ['prdctClsfcNoNm', 'prdctIdntNo', 'cntrctCorpNm', 'prodctCertYn'],
    normalize: normalizeProduct,
  },

  thpty: {
    id: 'thpty',
    label: '제3자단가계약 품목',
    hint: '수요기관을 위한 제3자단가계약 품목입니다.',
    operation: 'getThptyUcntrctPrdctInfoList',
    kind: 'product',
    dateParams: { bgn: 'rgstDtBgnDt', end: 'rgstDtEndDt' },
    dateFormats: ['ymdhm', 'ymd'],
    inqryDivs: DIV_PRODUCT,
    filters: ['prdctClsfcNoNm', 'prdctIdntNo', 'cntrctCorpNm', 'prodctCertYn'],
    normalize: normalizeProduct,
  },
};

export const DATASET_LIST = Object.values(DATASETS).map((d) => ({
  id: d.id,
  label: d.label,
  hint: d.hint,
  kind: d.kind,
  operation: d.operation,
  filters: d.filters,
  inqryDivs: d.inqryDivs,
}));

/** 화면에서 쓰는 필터 파라미터의 한글 이름 */
export const FILTER_LABELS = {
  prdctClsfcNoNm: '품명',
  dtilPrdctClsfcNoNm: '세부품명',
  prdctIdntNoNm: '물품규격명',
  prdctIdntNo: '물품식별번호',
  cntrctCorpNm: '계약업체명',
  shopngCntrctNo: '쇼핑계약번호',
  dlvrReqNo: '납품요구번호',
  cntrctNo: '계약번호',
  dminsttCd: '수요기관코드',
  dminsttNm: '수요기관명',
  masYn: '다수공급자계약(Y/N)',
  exclcProdctYn: '우수제품(Y/N)',
  prodctCertYn: '제품인증(Y/N)',
  regtCncelYn: '등록해지(Y/N)',
};

/** YYYYMMDD / YYYYMMDDHHMM 으로 맞춰준다. */
export function formatDateParam(ymd, format, edge) {
  const d = String(ymd || '').replace(/[^0-9]/g, '').slice(0, 8);
  if (d.length !== 8) return '';
  if (format === 'ymd') return d;
  return d + (edge === 'end' ? '2359' : '0000');
}
