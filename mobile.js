/**
 * 모바일 검색용 — 화면(app.js, PC 와 같은 파일) 앞에서 도는 연결 고리.
 *   - app.js 가 부르는 /api/... 를 서버 대신 worker.js(휴대폰 안 SQLite)로 보낸다.
 *   - 처음 한 번: 배포 폴더 링크를 받고, 모바일용 자료를 내려받는 동안 진행 화면을 띄운다.
 * app.js 보다 먼저 실행되어야 한다 (index.html 에서 일반 script 로 먼저 넣는다).
 */
(function () {
  document.documentElement.classList.add('mobile');
  const worker = new Worker('worker.js', { type: 'module' });
  const waiting = new Map();
  let seq = 0;

  function callApi(method, url, body) {
    return new Promise((resolve) => {
      const id = ++seq;
      waiting.set(id, resolve);
      worker.postMessage({ type: 'api', id, method, url, body });
    });
  }

  /* app.js 의 fetch('/api/...') 를 가로챈다 */
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const path = url.startsWith('/api/') ? url : (() => {
      try {
        const u = new URL(url, location.href);
        return u.origin === location.origin && u.pathname.includes('/api/') ? u.pathname.slice(u.pathname.indexOf('/api/')) + u.search : '';
      } catch {
        return '';
      }
    })();
    if (!path) return realFetch(input, init);
    let body = init.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {}
    }
    const r = await callApi(init.method || 'GET', path, body);
    // 화면이 첫 정보를 받으면 그제야 덮개를 걷는다 (그 전엔 빈 화면 대신 "불러오는 중")
    if (path.startsWith('/api/meta')) setTimeout(() => ((shownReady = true), (veil.hidden = true)), 50);
    if (r.body && r.body.__text != null) {
      return new Response(r.body.__text, { status: r.status, headers: { 'Content-Type': r.body.__type } });
    }
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } });
  };

  /* CSV 내려받기 (app.js openExport) */
  window.mobileExport = async (url) => {
    const r = await callApi('GET', url);
    if (r.status !== 200) return alert(r.body?.error || '내려받지 못했습니다.');
    const blob = new Blob(['﻿' + r.body.__text], { type: r.body.__type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = r.body.__name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };

  /* ── 처음 실행·내려받기 화면 ── */

  const veil = document.createElement('div');
  veil.id = 'mVeil';
  veil.innerHTML = '<div class="m-box"><h2>G2B Finder 모바일</h2><div id="mBody">불러오는 중…</div></div>';
  const mount = () => document.body.append(veil);
  document.body ? mount() : document.addEventListener('DOMContentLoaded', mount);
  const body = () => veil.querySelector('#mBody');
  const mb = (x) => (x / 1048576).toFixed(1);

  function show(html) {
    veil.hidden = false;
    body().innerHTML = html;
  }

  function askLink(err) {
    show(`
      <p>관리자 PC 의 <b>배포 폴더 공유 링크</b>를 넣어 주세요.<br>
      <span class="small muted">PC 의 G2B Finder → 수집·설정 → 동료 배포에 있는 OneDrive 링크(https://1drv.ms/…)입니다.
      한 번만 넣으면 이 휴대폰에 기억합니다.</span></p>
      ${err ? `<div class="notice warn">${err}</div>` : ''}
      <input id="mLink" type="url" inputmode="url" placeholder="https://1drv.ms/f/…" autocomplete="off" />
      <button class="btn primary" id="mLinkGo">자료 받기 시작</button>
      <p class="small muted">처음에 약 40MB 를 받습니다 (와이파이를 권합니다). 휴대폰 저장 공간은 약 250MB 를 씁니다.</p>
      ${installed() ? '' : '<button class="btn" id="mInstallVeil">먼저 앱으로 설치하기 (홈 화면 아이콘)</button>'}`);
    veil.querySelector('#mInstallVeil')?.addEventListener('click', () => installBtn.click());
    veil.querySelector('#mLinkGo').addEventListener('click', () => {
      const link = veil.querySelector('#mLink').value.trim();
      if (!/^https:\/\/(1drv\.ms|onedrive\.live\.com)\//.test(link) && !/^\/[\w/-]+\/$/.test(link)) return askLink('OneDrive 공유 링크(https://1drv.ms/… 또는 https://onedrive.live.com/…)를 넣어 주세요.');
      worker.postMessage({ type: 'link', link });
      show('배포 폴더를 여는 중…');
    });
  }

  let shownReady = false;
  worker.addEventListener('message', (e) => {
    const m = e.data || {};
    if (m.type === 'api') {
      const r = waiting.get(m.id);
      waiting.delete(m.id);
      r && r(m);
      return;
    }
    if (m.type === 'reload') {
      show(`${m.why || '새 자료를 받았습니다.'}<br>새로 고칩니다…`);
      setTimeout(() => location.reload(), 1200);
      return;
    }
    if (m.type !== 'status') return;
    const s = m.status;
    if (s.phase === 'need-link') return askLink(s.error);
    if (s.phase === 'download' && (!shownReady || !s.progress)) {
      const p = s.progress || {};
      const pct = p.total ? Math.min(100, Math.round((p.got / p.total) * 100)) : 0;
      return show(`모바일용 자료를 받는 중입니다… <b>${pct}%</b>
        <div class="m-bar"><div style="width:${pct}%"></div></div>
        <span class="small muted">${mb(p.got || 0)} / ${mb(p.total || 0)}MB · 화면을 끄거나 다른 앱으로 가면 멈출 수 있습니다.</span>`);
    }
    if (s.phase === 'prepare' && !shownReady) return show('받은 자료를 정리하는 중…');
    if (s.phase === 'patch' && !shownReady) return show('새 변경분을 더하는 중…');
    if (s.phase === 'error' && !shownReady) {
      show(`<div class="notice warn">${s.error || '자료를 받지 못했습니다.'}</div>
        <button class="btn primary" id="mRetry">다시 시도</button>
        <button class="btn" id="mRelink">링크 다시 넣기</button>`);
      veil.querySelector('#mRetry').addEventListener('click', () => (show('다시 시도하는 중…'), worker.postMessage({ type: 'start' })));
      veil.querySelector('#mRelink').addEventListener('click', () => askLink());
      return;
    }
    if (s.phase === 'ready' && !shownReady) show('불러오는 중…');
  });

  /*
   * 검색 조건 칸 접기 — 거래내역 13칸·등록품목 10칸이 휴대폰에서는 세로로 길게 늘어선다.
   * 자주 쓰는 칸만 위에 두고 나머지는 "조건 더 보기" 로 접는다 (넣은 값이 있으면 개수를 알린다).
   * 칸 자체는 PC 와 같은 것이라 검색 동작은 그대로다.
   */
  const KEEP = {
    'tab-orders': ['oDtil', 'oFrom', 'oTo', 'oKeyword'],
    'tab-products': ['pDtil', 'pCorp', 'pKeyword', 'pSort'],
  };
  function compactFilters() {
    for (const [tab, keep] of Object.entries(KEEP)) {
      const grid = document.querySelector(`#${tab} .filters`);
      if (!grid) continue;
      const more = [];
      for (const cell of grid.children) {
        const id = cell.querySelector('input,select')?.id;
        const i = keep.indexOf(id);
        if (i >= 0) cell.style.order = String(i);
        else (cell.style.order = '10'), cell.classList.add('m-more'), more.push(cell);
      }
      const extra = grid.nextElementSibling?.classList.contains('row') ? grid.nextElementSibling : null;
      extra?.classList.add('m-more-row');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn m-more-btn';
      grid.after(btn);
      const filled = () =>
        more.filter((c) => {
          const el = c.querySelector('input,select');
          return el && el.value && !(el.tagName === 'SELECT' && el.selectedIndex === 0);
        }).length + (extra ? extra.querySelectorAll('input:checked').length : 0);
      const label = () => {
        const open = grid.classList.contains('m-open');
        const n = filled();
        btn.textContent = open ? '조건 접기 ▴' : `조건 더 보기${n ? ` (${n}개 넣음)` : ''} ▾`;
      };
      btn.addEventListener('click', () => {
        grid.classList.toggle('m-open');
        extra?.classList.toggle('m-open', grid.classList.contains('m-open'));
        label();
      });
      grid.addEventListener('input', label);
      grid.addEventListener('change', label);
      extra?.addEventListener('change', label);
      label();
      setTimeout(label, 1500); // 앱이 지난 조건을 채워 넣은 뒤
    }
  }
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', compactFilters) : compactFilters();

  /*
   * 앱으로 설치 — 크롬이 이 사이트를 앱(아이콘·전체 화면)으로 설치한다. APK 와 달리 보안 경고가 없다.
   * 크롬이 설치를 허락하면(beforeinstallprompt) 버튼 한 번으로 설치 창을 띄우고,
   * 그 밖의 브라우저(아이폰 사파리·삼성 인터넷)나 아직 허락 전이면 메뉴에서 설치하는 방법을 보여 준다.
   * 이미 앱으로 열었거나 안드로이드 앱(APK) 안이면 버튼을 숨긴다.
   */
  const installed = () =>
    matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches || navigator.standalone || window.Capacitor;
  let installEvt = null;
  const installBtn = document.createElement('button');
  installBtn.type = 'button';
  installBtn.className = 'btn primary';
  installBtn.id = 'mInstallBtn';
  installBtn.textContent = '앱 설치';
  installBtn.title = '홈 화면에 G2B Finder 아이콘을 만듭니다';
  installBtn.hidden = true;
  const placeInstall = () => {
    document.querySelector('.headinfo')?.prepend(installBtn);
    installBtn.hidden = Boolean(installed());
  };
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', placeInstall) : placeInstall();

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // 크롬이 아래에 띄우는 작은 안내 대신 버튼으로
    installEvt = e;
  });
  window.addEventListener('appinstalled', () => {
    installEvt = null;
    installBtn.hidden = true;
  });

  function installGuide() {
    const ua = navigator.userAgent;
    const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
    const samsung = /SamsungBrowser/.test(ua);
    const steps = ios
      ? '<b>사파리</b>로 이 주소를 열고, 아래쪽 <b>공유 버튼(□↑)</b> → <b>홈 화면에 추가</b> → <b>추가</b>를 누르세요.'
      : samsung
        ? '아래쪽 <b>메뉴(≡)</b> → <b>현재 페이지 추가</b> → <b>홈 화면</b>을 누르세요.<br><span class="small muted">크롬으로 열면 버튼 한 번으로 설치됩니다.</span>'
        : '오른쪽 위 <b>메뉴(⋮)</b> → <b>앱 설치</b> (또는 <b>홈 화면에 추가 → 설치</b>)를 누르세요.<br><span class="small muted">메뉴에 안 보이면 잠시 뒤(첫 화면을 다 받은 뒤) 다시 해 보세요.</span>';
    const box = document.createElement('div');
    box.id = 'mInstall';
    box.innerHTML = `<div class="m-box"><h2>앱으로 설치</h2>
      <p>${steps}</p>
      <p class="small muted">홈 화면·앱 목록에 G2B Finder 아이콘이 생기고, 주소창 없이 앱처럼 열립니다.
      보안 경고나 "출처를 알 수 없는 앱" 허용이 필요 없습니다.</p>
      <button class="btn" id="mInstallClose">닫기</button></div>`;
    document.body.append(box);
    box.querySelector('#mInstallClose').addEventListener('click', () => box.remove());
    box.addEventListener('click', (e) => e.target === box && box.remove());
  }

  installBtn.addEventListener('click', async () => {
    if (!installEvt) return installGuide();
    const e = installEvt;
    installEvt = null; // 설치 창은 한 번만 띄울 수 있다
    e.prompt();
    const r = await e.userChoice.catch(() => null);
    if (r?.outcome === 'accepted') installBtn.hidden = true;
  });

  // 저장 공간을 브라우저가 마음대로 비우지 않게 (받은 자료 250MB)
  navigator.storage?.persist?.().catch(() => {});
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

  // 다른 앱에 갔다가 돌아오면 새 자료 확인
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') worker.postMessage({ type: 'check' });
  });

  worker.postMessage({ type: 'start' });
  window.mobileWorker = worker;
})();
