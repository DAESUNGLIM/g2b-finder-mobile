/**
 * 모바일 검색용 — PC 의 src/config.js 대신 쓰는 것. 휴대폰은 검색만 하고 API 를 부르지 않는다.
 */

import { getConfig, setConfig } from './db.js';

export const VIEWER = true;
export const isMock = () => false;
export const serviceKey = () => '';
export const baseUrl = () => '';

/** 내 회사 — 배포 목록(manifest.myCorps)에서 받아 둔 것 */
export function myCorps() {
  const list = getConfig('myCorps', []);
  return Array.isArray(list) ? list : [];
}

export function publicSettings() {
  return {
    hasServiceKey: false,
    serviceKeyFromEnv: false,
    forceMock: false,
    mock: false,
    baseUrl: '',
    myCorps: myCorps(),
    dailyLimit: 0,
    autoFill: false,
    autoFillMaxDays: 31,
    learned: {},
  };
}

export function saveSettings(patch = {}) {
  if (Array.isArray(patch.myCorps)) {
    setConfig(
      'myCorps',
      patch.myCorps
        .map((c) => ({ name: String(c?.name || '').trim(), bizno: String(c?.bizno || '').replace(/[^0-9]/g, '') }))
        .filter((c) => c.name || c.bizno)
    );
  }
  return publicSettings();
}
