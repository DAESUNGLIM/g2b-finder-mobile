/**
 * 공공데이터포털(data.go.kr) 나라장터쇼핑몰 OpenAPI 저수준 클라이언트.
 *
 * - 종합쇼핑몰 품목정보서비스 : https://apis.data.go.kr/1230000/at/ShoppingMallPrdctInfoService
 *   (data.go.kr 데이터 15129471 / 활용신청 후 인증키 사용)
 *
 * 조달청이 엔드포인트를 바꾸는 경우가 있어 BASE_URL 은 설정에서 덮어쓸 수 있다.
 */

import { recordApiCall } from './usage.js';

export const DEFAULT_BASE = 'https://apis.data.go.kr/1230000/at/ShoppingMallPrdctInfoService';

/** data.go.kr 오류코드 -> 한글 안내 */
export const ERROR_HINTS = {
  '01': '어플리케이션 에러입니다. 잠시 후 다시 시도하세요.',
  '02': '데이터베이스 에러입니다. 잠시 후 다시 시도하세요.',
  '03': '조회 결과가 없습니다.',
  '04': 'HTTP 에러입니다.',
  '05': '서비스 연결이 실패했습니다.',
  '10': '잘못된 요청 파라미터입니다. (조회구분·날짜형식을 확인하세요)',
  '11': '필수 요청 파라미터가 빠졌습니다.',
  '12': '해당 오퍼레이션이 폐기되었습니다.',
  '20': '서비스 접근이 거부되었습니다. 활용신청 승인 여부를 확인하세요.',
  '21': '일시적으로 사용이 중지된 키입니다.',
  '22': '일일 트래픽 한도를 초과했습니다.',
  '30': '등록되지 않은 서비스키입니다. 키 값과 활용신청 승인을 확인하세요.',
  '31': '활용기간이 만료된 서비스키입니다.',
  '32': '등록되지 않은 도메인/IP 입니다.',
  '99': '기타 오류입니다.',
};

/** 재시도해도 소용없는 코드 (키·권한·파라미터 문제) */
const FATAL_CODES = ['NO_KEY', '10', '11', '12', '20', '21', '22', '30', '31', '32'];

export class G2BError extends Error {
  constructor(message, { code, operation, hint, raw } = {}) {
    super(message);
    this.name = 'G2BError';
    this.code = code || null;
    this.operation = operation || null;
    this.hint = hint || null;
    this.raw = raw || null;
  }
}

export function isFatal(err) {
  return err instanceof G2BError && FATAL_CODES.includes(err.code);
}

/**
 * 포털은 "인코딩 키"와 "디코딩 키" 두 가지를 준다.
 * 어느 쪽을 붙여넣어도 동작하도록 한 번 디코딩한 뒤 우리가 다시 인코딩한다.
 */
export function normalizeServiceKey(key) {
  const trimmed = String(key || '').trim();
  if (!trimmed) return '';
  let decoded = trimmed;
  if (/%[0-9A-Fa-f]{2}/.test(trimmed)) {
    try {
      decoded = decodeURIComponent(trimmed);
    } catch {
      decoded = trimmed;
    }
  }
  return encodeURIComponent(decoded);
}

function textOf(xml, tag) {
  const m = new RegExp(`<${tag}>([\s\S]*?)</${tag}>`).exec(xml);
  return m ? m[1].trim() : null;
}

/** XML(주로 오류응답)에서 코드/메시지를 뽑아낸다. */
function parseXmlError(body) {
  const code =
    textOf(body, 'resultCode') || textOf(body, 'returnReasonCode') || textOf(body, 'errMsg');
  const msg =
    textOf(body, 'resultMsg') ||
    textOf(body, 'returnAuthMsg') ||
    textOf(body, 'errMsg') ||
    body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  return { code: code ? String(code).padStart(2, '0') : null, msg };
}

export function asArray(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'object' && Array.isArray(value.item)) return value.item;
  if (typeof value === 'object' && value.item) return [value.item];
  return [value];
}

const EMPTY = (operation, url) => ({
  items: [],
  totalCount: 0,
  pageNo: 1,
  numOfRows: 0,
  operation,
  url,
});

/**
 * 오퍼레이션 1회 호출.
 * @returns {Promise<{items:object[], totalCount:number, pageNo:number, numOfRows:number, operation:string, url:string}>}
 */
export async function callOperation({
  operation,
  params = {},
  serviceKey,
  baseUrl,
  timeoutMs = 25000,
  retries = 2,
}) {
  if (!serviceKey) {
    throw new G2BError('서비스키가 설정되지 않았습니다.', {
      code: 'NO_KEY',
      hint: '설정 화면에서 공공데이터포털 인증키를 입력하세요.',
      operation,
    });
  }

  const base = (baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    search.set(k, String(v));
  }
  if (!search.has('type') && !search.has('Type')) search.set('type', 'json');
  // serviceKey 는 이미 인코딩된 값이므로 URLSearchParams 를 거치지 않고 직접 붙인다.
  const url = `${base}/${operation}?serviceKey=${serviceKey}&${search.toString()}`;
  const safeUrl = url.replace(serviceKey, '***');

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let res;
      // 재시도도 포털 쪽에서는 한 번의 요청이므로 보내기 전에 센다.
      recordApiCall(operation);
      try {
        res = await fetch(url, {
          signal: controller.signal,
          headers: { Accept: 'application/json' },
        });
      } finally {
        clearTimeout(timer);
      }

      const trimmed = (await res.text()).trim();

      // 오류는 type=json 이어도 XML/HTML 로 오는 경우가 많다.
      if (trimmed.startsWith('<')) {
        const { code, msg } = parseXmlError(trimmed);
        if (code === '03') return EMPTY(operation, safeUrl);
        throw new G2BError(msg || 'API 오류', {
          code,
          operation,
          hint: ERROR_HINTS[code] || null,
          raw: trimmed.slice(0, 500),
        });
      }

      let json;
      try {
        json = JSON.parse(trimmed);
      } catch {
        throw new G2BError('API 응답을 해석할 수 없습니다.', {
          operation,
          raw: trimmed.slice(0, 500),
        });
      }

      const header = json?.response?.header ?? json?.header ?? {};
      const code = header.resultCode != null ? String(header.resultCode).padStart(2, '0') : null;
      if (code && code !== '00') {
        if (code === '03') return EMPTY(operation, safeUrl);
        throw new G2BError(header.resultMsg || 'API 오류', {
          code,
          operation,
          hint: ERROR_HINTS[code] || null,
          raw: JSON.stringify(header),
        });
      }

      const body = json?.response?.body ?? json?.body ?? {};
      return {
        items: asArray(body.items),
        totalCount: Number(body.totalCount ?? 0),
        pageNo: Number(body.pageNo ?? 1),
        numOfRows: Number(body.numOfRows ?? 0),
        operation,
        url: safeUrl,
      };
    } catch (err) {
      lastErr = err;
      if (isFatal(err)) break;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  throw lastErr;
}
