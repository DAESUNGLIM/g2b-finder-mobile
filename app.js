/* G2B Finder — 화면 전체 로직 (빌드 도구 없이 브라우저가 그대로 읽는다) */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/* ── 공통 유틸 ────────────────────────────────────────────────── */

const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const n = (v) => Number(v || 0).toLocaleString('ko-KR');

/** 큰 금액은 억/만 단위로 줄여 읽기 쉽게 */
function won(v) {
  const x = Number(v || 0);
  if (x >= 1e12) {
    const eok = Math.round(x / 1e8);
    return `${Math.floor(eok / 1e4).toLocaleString('ko-KR')}조 ${(eok % 1e4).toLocaleString('ko-KR')}억`;
  }
  if (x >= 1e8) return (x / 1e8).toFixed(x >= 1e9 ? 0 : 1) + '억';
  if (x >= 1e4) return Math.round(x / 1e4).toLocaleString('ko-KR') + '만';
  return x.toLocaleString('ko-KR');
}

/** YYYYMMDD -> YYYY-MM-DD */
const ymd = (v) => {
  const s = String(v || '').replace(/[^0-9]/g, '');
  return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s || '-';
};

/** <input type=date> 값 -> YYYYMMDD */
const dateVal = (id) => String($(id)?.value || '').replace(/-/g, '');

const setDate = (id, ymdStr) => {
  const el = $(id);
  if (el) el.value = ymd(ymdStr) === '-' ? '' : ymd(ymdStr);
};

function daysAgo(days) {
  const d = new Date(Date.now() - days * 86400000);
  return d.toISOString().slice(0, 10);
}

/** CSV 내려받기 — PC 는 그 주소로 가면 되고, 모바일 검색용(mobile/mobile.js)은 휴대폰 안에서 만들어 내려 준다 */
function openExport(url) {
  if (window.mobileExport) return window.mobileExport(url);
  location.href = url;
}

async function api(path, options) {
  const res = await fetch('/api' + path, options);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(text.slice(0, 200) || `요청 실패 (${res.status})`);
  }
  if (!res.ok) {
    const err = new Error(body.error || `요청 실패 (${res.status})`);
    err.hint = body.hint;
    err.code = body.code;
    throw err;
  }
  return body;
}

const qs = (obj) =>
  Object.entries(obj)
    .filter(([, v]) => v !== '' && v !== undefined && v !== null && v !== false)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

function tiles(list) {
  return list
    .map(
      (t) =>
        `<div class="tile"><div class="k">${esc(t.k)}</div><div class="v">${t.v}</div>${
          t.u ? `<div class="u">${esc(t.u)}</div>` : ''
        }</div>`
    )
    .join('');
}

function tableHtml(cols, rows, rowFn) {
  if (!rows.length) return '<tbody><tr><td class="empty">조건에 맞는 자료가 없습니다.</td></tr></tbody>';
  const head = `<thead><tr>${cols
    .map((c) => `<th class="${c.num ? 'num' : ''}">${esc(c.label)}</th>`)
    .join('')}</tr></thead>`;
  const body = `<tbody>${rows.map(rowFn).join('')}</tbody>`;
  return head + body;
}

function notice(target, kind, html) {
  const el = $(target);
  if (el) el.innerHTML = html ? `<div class="notice ${kind}">${html}</div>` : '';
}

function pager(target, total, page, size, onGo) {
  const pages = Math.max(1, Math.ceil(total / size));
  const el = $(target);
  if (!el) return;
  if (total === 0) return (el.innerHTML = '');
  const btn = (p, label, on) =>
    `<button class="btn ${on ? 'primary' : ''}" data-p="${p}" ${p < 1 || p > pages ? 'disabled' : ''}>${label}</button>`;
  const from = Math.max(1, page - 2);
  const to = Math.min(pages, from + 4);
  let html = btn(1, '«') + btn(page - 1, '‹');
  for (let p = from; p <= to; p++) html += btn(p, String(p), p === page);
  html += btn(page + 1, '›') + btn(pages, '»');
  html += `<span class="small muted" style="margin-left:8px">${n(total)}건 / ${pages}쪽</span>`;
  el.innerHTML = html;
  $$('button[data-p]', el).forEach((b) =>
    b.addEventListener('click', () => onGo(Number(b.dataset.p)))
  );
}

/* ── 빠진 날짜 채우기 ─────────────────────────────────────────── */

/** 진행 중인 수집이 끝날 때까지 기다린다. onTick 으로 진행 상황을 받는다. */
async function waitCollect(onTick) {
  for (;;) {
    const { job } = await api('/collect/status');
    onTick?.(job);
    if (!job || !job.running) return job;
    await new Promise((r) => setTimeout(r, 800));
  }
}

function fillBanner(kind, html) {
  $('#fillBanner').innerHTML = html ? `<div class="notice ${kind}">${html}</div>` : '';
}

/**
 * 세부품명이 없으면 검색하지 않는다 — 세부품명 없이 빠진 날짜를 채우면 전체 품목(하루 API 15회 안팎)을 받게 된다.
 * 없으면 안내를 띄우고 결과 칸을 비운 뒤 false.
 */
function requireDtil(dtil, inputId, clearIds) {
  if (dtil) return true;
  clearIds.forEach((id) => ($(id).innerHTML = ''));
  fillBanner(
    'warn',
    state.viewer
      ? '<b>세부품명</b>을 넣고 검색하세요.'
      : '<b>세부품명</b>을 넣고 검색하세요. 세부품명 없이 검색하면 전체 품목을 API 로 받게 되어 하루 한도를 금방 씁니다.'
  );
  $(inputId).focus();
  return false;
}

/**
 * 등록품목은 세부품명이나 계약업체 중 하나만 있으면 검색한다.
 * 업체만으로 찾을 때는 저장된 자료에서만 찾고 API 로 받지 않는다 (ensureCoverage 는 세부품명이 있어야 받음).
 */
function requireProductScope(pq, clearIds) {
  if (pq.dtil || pq.corp) return true;
  clearIds.forEach((id) => ($(id).innerHTML = ''));
  fillBanner(
    'warn',
    state.viewer
      ? '<b>세부품명</b>이나 <b>계약업체</b>를 넣고 검색하세요.'
      : '<b>세부품명</b>이나 <b>계약업체</b>를 넣고 검색하세요. 둘 다 없이 검색하면 전체 품목을 API 로 받게 되어 하루 한도를 금방 씁니다.'
  );
  $('#pDtil').focus();
  return false;
}

/**
 * 검색 기간 가운데 저장 안 된 날짜만 API 로 받아 채운 뒤 rerun() 으로 다시 검색한다.
 * 결과는 먼저 저장된 자료로 보여주고, 채운 뒤에 새로 그린다.
 *
 * mode
 *   'auto' : 사용자가 검색 버튼을 눌렀을 때 — 설정·한도 안이면 바로 받는다
 *   'ask'  : 탭을 열었을 때 — 알리기만 하고 버튼으로 물어본다
 */
async function ensureCoverage({ from, to, dtil, mode, rerun, dataset = 'dlvrDtl', ignoreMaxDays = false }) {
  if (!from || !to) return fillBanner('', '');
  if (!dtil) return; // 전체 품목은 받지 않는다 (requireDtil 참고)
  let cov;
  try {
    cov = await api('/coverage?' + qs({ dataset, from, to, dtil }));
  } catch {
    return; // 범위 확인이 실패해도 검색 결과는 이미 나와 있다.
  }
  if (!cov.missingDays) {
    return fillBanner(
      '',
      cov.totalDays
        ? `<span class="small">${ymd(cov.from)} ~ ${ymd(cov.to)} ${n(cov.totalDays)}일 모두 저장된 자료로 보여드렸습니다 · API 호출 0회</span>`
        : ''
    );
  }

  if (state.viewer) {
    // 검색 전용은 받지 않는다 — 관리자 PC 에 대신 받아 달라고 요청한다
    const req = { dataset, from: cov.from, to: cov.to, dtil };
    fillBanner(
      'warn',
      `${ymd(cov.from)} ~ ${ymd(cov.to)} 가운데 <b>${n(cov.missingDays)}일치</b>는 아직 받아 둔 자료가 없습니다.` +
        `<br><span class="small">검색 전용 프로그램이라 직접 받을 수 없습니다. 관리자 PC 에 요청하면 대신 받아서 몇 분 뒤 여기에도 들어옵니다.</span>` +
        ` <button class="btn primary" id="reqSend">관리자에게 요청 보내기</button>`
    );
    const askFailed = (why) =>
      fillBanner(
        'warn',
        `요청을 보내지 못했습니다${why ? ` — <span class="small">${esc(why)}</span>` : ''}` +
          `<br><span class="small">관리자에게 <b>${esc(dtil)} · ${ymd(cov.from)} ~ ${ymd(cov.to)}</b> 자료가 필요하다고 알려 주세요.</span>`
      );
    $('#reqSend').addEventListener('click', async () => {
      const b = $('#reqSend');
      b.disabled = true;
      b.textContent = '보내는 중…';
      try {
        const r = await api('/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req) });
        if (r.state === 'sent') return fillBanner('', '요청을 보냈습니다. 관리자 PC 가 받으면 몇 분 뒤 이 화면에도 들어옵니다.');
        if (r.state === 'dup') return fillBanner('', '이미 요청한 자료입니다. 관리자 PC 가 받으면 저절로 들어옵니다.');
        askFailed(r.error); // 관리자 PC 가 요청 받기를 아직 안 켰거나 연결이 막혔다
      } catch (err) {
        askFailed(err.message);
      }
    });
    return;
  }
  const s = state.settings;
  const est = cov.estCalls;
  const estText = cov.mock ? '샘플 모드라 API 호출 없음' : est == null ? '예상 호출 수는 첫 수집 뒤부터 계산됩니다' : `예상 API 약 ${n(est)}회 · 오늘 남은 ${n(cov.remainingCalls)}회`;
  const what = `${ymd(cov.from)} ~ ${ymd(cov.to)} 가운데 <b>${n(cov.missingDays)}일치</b>가 아직 저장되지 않았습니다 <span class="small muted">(${estText})</span>`;

  if (cov.collecting) {
    return fillBanner('warn', `${what}<br><span class="small">다른 수집이 진행 중입니다. 끝난 뒤 다시 검색하면 채워집니다.</span>`);
  }

  // 등록품목은 등록일 기준이라 기간이 길 수밖에 없어 일수 제한 대신 호출 수만 본다.
  const overDays = !ignoreMaxDays && cov.missingDays > (s.autoFillMaxDays || 31);
  const overQuota = !cov.mock && est != null && est > cov.remainingCalls;
  const doFill = async () => {
    fillBanner('', `${what}<br>빠진 날짜만 받는 중…`);
    try {
      await api('/collect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          datasetId: dataset,
          bgnDate: cov.from,
          endDate: cov.to,
          onlyMissing: true,
          // 세부품명으로 검색했으면 API 도 그 세부품명만 받는다 (전체를 받으면 하루 15회 안팎 든다).
          filters: cov.filters,
          numOfRows: 999,
          maxPages: 200,
          chunkDays: cov.chunkDays || 7,
        }),
      });
      const job = await waitCollect((j) => {
        if (j?.running) {
          fillBanner('', `빠진 ${n(j.targetDays)}일치 받는 중… ${j.chunkDone}/${j.chunkTotal} 구간 · ${n(j.fetched)}건 · API ${n(j.calls)}회`);
        }
      });
      // 다시 검색하면 안내가 지워지므로, 결과를 먼저 새로 그린 뒤 안내를 띄운다.
      await rerun();
      await refreshMeta();
      if (job?.error) {
        fillBanner('err', `받는 도중 멈췄습니다: ${esc(job.error.message)}${job.error.hint ? ' — ' + esc(job.error.hint) : ''}<br><span class="small">받은 만큼은 저장됐고, 다음 검색 때 나머지만 이어 받습니다.</span>`);
      } else {
        fillBanner(
          '',
          `새로 ${n(job.targetDays)}일치 ${n(job.fetched)}건을 받아 채웠습니다 (API ${n(job.calls)}회)` +
            (job.skippedDays ? ` · 나머지 ${n(job.skippedDays)}일은 저장된 자료를 썼습니다` : '') +
            (job.incompleteChunks ? `<br><span class="small">일부 구간은 양이 많아 다 못 받았습니다. 다시 검색하면 이어 받습니다.</span>` : '')
        );
      }
    } catch (err) {
      fillBanner('err', esc(err.message));
    }
  };

  if (mode === 'auto' && s.autoFill && !overDays && !overQuota) return doFill();

  const why =
    mode !== 'auto'
      ? ''
      : !s.autoFill
        ? '자동 받기가 꺼져 있습니다.'
        : overDays
          ? `자동으로 받는 최대 ${n(s.autoFillMaxDays)}일을 넘습니다.`
          : '예상 호출 수가 오늘 남은 한도보다 많습니다.';
  fillBanner(
    'warn',
    `${what}<br><span class="small">${why}</span> <button class="btn primary" id="fillGo">빠진 ${n(cov.missingDays)}일치만 받기</button>`
  );
  $('#fillGo').addEventListener('click', doFill);
}

/* ── 상태 ─────────────────────────────────────────────────────── */

const state = {
  meta: null,
  datasets: [],
  settings: {},
  orders: { page: 1, size: 50, last: null },
  products: { page: 1, size: 50 },
  pollTimer: null,
};

/* ── 탭 ───────────────────────────────────────────────────────── */

const TAB_LOADERS = {
  home: loadHome,
  orders: () => searchOrders(1, 'ask'),
  products: () => searchProducts(1, 'ask'),
  contracts: loadContracts,
  compare: loadCompare,
  mine: () => loadPerf(),
  marks: loadBookmarks,
  settings: loadSettings,
};

// 상단 탭 하나에 여러 화면을 묶은 것. 화면 이름(주소창 #)은 그대로 두고 하위 메뉴로 고른다.
const TAB_GROUPS = {
  manage: [['home', '현황 · 수집'], ['settings', '설정']],
};

function groupOf(name) {
  return Object.keys(TAB_GROUPS).find((g) => TAB_GROUPS[g].some(([n]) => n === name)) || name;
}

function lastSub(group) {
  try {
    const n = localStorage.getItem('sub:' + group);
    if (TAB_GROUPS[group].some(([k]) => k === n)) return n;
  } catch {}
  return TAB_GROUPS[group][0][0];
}

function showTab(name) {
  if (state.viewer && ['home', 'settings', 'manage', 'contracts'].includes(name)) name = 'orders'; // 검색 전용은 수집·설정·계약 내역이 없다
  if (TAB_GROUPS[name]) name = lastSub(name);
  if (!$('#tab-' + name)) name = 'home';
  const group = groupOf(name);
  $$('nav button').forEach((b) => b.classList.toggle('on', b.dataset.tab === group));

  const subs = TAB_GROUPS[group];
  const bar = $('#subnav');
  bar.hidden = !subs;
  if (subs) {
    try { localStorage.setItem('sub:' + group, name); } catch {}
    bar.innerHTML = subs
      .map(([n, label]) => `<button data-sub="${n}" class="${n === name ? 'on' : ''}">${label}</button>`)
      .join('');
    bar.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.sub)));
  }

  $$('main > section').forEach((s) => (s.hidden = s.id !== 'tab-' + name));
  location.hash = name;
  fillBanner('', '');
  TAB_LOADERS[name]?.();
}

/* ── 초기화 ───────────────────────────────────────────────────── */

async function boot() {
  $('#themeBtn').addEventListener('click', toggleTheme);
  $('#quitBtn').addEventListener('click', quitApp);
  applyTheme(localStorage.getItem('theme') || 'light');

  $$('nav button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

  // 기본 기간: 최근 30일
  ['#colFrom', '#oFrom'].forEach((id) => ($(id).value = daysAgo(30)));
  // 내 실적은 저장된 자료만 집계하므로 기간을 넉넉히 — 올해 1월 1일부터.
  $('#mFrom').value = daysAgo(1).slice(0, 4) + '-01-01';
  ['#colTo', '#oTo', '#mTo'].forEach((id) => ($(id).value = daysAgo(1)));

  $$('.chip[data-range]').forEach((c) =>
    c.addEventListener('click', () => {
      $('#colFrom').value = daysAgo(Number(c.dataset.range));
      $('#colTo').value = daysAgo(1);
    })
  );

  $('#colRun').addEventListener('click', startCollect);
  $('#diagBtn').addEventListener('click', diagnose);
  // 세부품명·품명 칸 자동완성
  ['#oDtil', '#pDtil'].forEach((id) => attachItemSuggest($(id), () => 'dtil'));
  ['#oClsfc', '#pClsfc'].forEach((id) => attachItemSuggest($(id), () => 'clsfc'));
  // 업체·기관·지역 칸 — 저장된 거래내역에서, 세부품명을 넣었으면 그 품목 안에서
  const oDtil = () => $('#oDtil').value.trim();
  attachOrderSuggest($('#oCorp'), 'corp', oDtil);
  attachOrderSuggest($('#oInstt'), 'instt', oDtil);
  attachOrderSuggest($('#oRgn'), 'rgn', oDtil);
  attachOrderSuggest($('#oCorpLoc'), 'corpLoc', oDtil);
  const pDtil = () => $('#pDtil').value.trim();
  attachProductSuggest($('#pCorp'), 'corp', pDtil);
  attachProductSuggest($('#pLoc'), 'loc', pDtil);
  attachItemSuggest($('#colFilter'), () =>
    itemFilterOf(state.datasets.find((d) => d.id === $('#colDataset').value)) === 'prdctClsfcNoNm' ? 'clsfc' : 'dtil'
  );
  $('#clsfcSync').addEventListener('click', syncClsfcNow);
  $('#corpLocFill').addEventListener('click', fillCorpLocNow);

  $('#impPickFiles').addEventListener('click', () => $('#impFiles').click());
  $('#impPickDir').addEventListener('click', () => $('#impDir').click());
  $('#impPathRun').addEventListener('click', importFromPath);
  // 파일을 카드에 끌어다 놓아도 가져온다
  const card = $('#impCard');
  card.addEventListener('dragover', (e) => {
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
    e.preventDefault();
    card.classList.add('drop-on');
  });
  card.addEventListener('dragleave', (e) => !card.contains(e.relatedTarget) && card.classList.remove('drop-on'));
  card.addEventListener('drop', (e) => {
    e.preventDefault();
    card.classList.remove('drop-on');
    if ($('#impPickFiles').disabled) return; // 가져오는 중
    importFiles([...(e.dataTransfer?.files || [])]);
  });
  api('/import/last')
    .then((r) => r.path && !$('#impPath').value && ($('#impPath').value = r.path))
    .catch(() => {});
  ['#impFiles', '#impDir'].forEach((id) =>
    $(id).addEventListener('change', (e) => {
      importFiles([...e.target.files]);
      e.target.value = '';
    })
  );

  $('#oSearch').addEventListener('click', () => searchOrders(1, 'auto'));
  $('#oReset').addEventListener('click', () => {
    ['#oKeyword', '#oCorp', '#oBizno', '#oCorpLoc', '#oInstt', '#oRgn', '#oClsfc', '#oDtil', '#oAmtMin', '#oAmtMax'].forEach(
      (id) => ($(id).value = '')
    );
    ['#oMine', '#oMas', '#oExclc', '#oSme'].forEach((id) => ($(id).checked = false));
    searchOrders(1, 'ask');
  });
  $('#oCsv').addEventListener('click', () => {
    if (!requireDtil(orderQuery().dtil, '#oDtil', [])) return;
    if (orderView() !== 'list') return downloadGroupCsv();
    openExport('/api/export?' + qs({ kind: 'orders', ...orderQuery() }));
  });
  try {
    const v = localStorage.getItem('orderView');
    if (v && $(`#oView option[value="${v}"]`)) $('#oView').value = v;
    const gn = localStorage.getItem('orderGroupN');
    if (gn && $(`#oGroupN option[value="${gn}"]`)) $('#oGroupN').value = gn;
  } catch {}
  applyOrderView();
  ['#oView', '#oGroupN'].forEach((id) =>
    $(id).addEventListener('change', () => {
      applyOrderView();
      if (orderQuery().dtil) searchOrders(1);
    })
  );
  $('#oKeyword').addEventListener('keydown', (e) => e.key === 'Enter' && searchOrders(1, 'auto'));
  $('#oDtil').addEventListener('keydown', (e) => e.key === 'Enter' && searchOrders(1, 'auto'));

  $('#pSearch').addEventListener('click', () => searchProducts(1, 'auto'));
  initThumbPreview('#pTable');
  initThumbPreview('#cmpTable');
  initThumbPreview('#bTable');
  $('#pReset').addEventListener('click', () => {
    ['#pKeyword', '#pClsfc', '#pDtil', '#pCorp', '#pLoc', '#pIdnt', '#pMin', '#pMax'].forEach((id) => ($(id).value = ''));
    ['#pMas', '#pExclc', '#pSme', '#pMine', '#pOld'].forEach((id) => ($(id).checked = false));
    $('#pDataset').value = '';
    searchProducts(1);
  });
  $('#pCsv').addEventListener('click', () => {
    if (!requireProductScope(productQuery(), [])) return;
    openExport('/api/export?' + qs({ kind: 'products', ...productQuery() }));
  });
  $('#pKeyword').addEventListener('keydown', (e) => e.key === 'Enter' && searchProducts(1, 'auto'));
  $('#pDtil').addEventListener('keydown', (e) => e.key === 'Enter' && searchProducts(1, 'auto'));
  $('#pCorp').addEventListener('keydown', (e) => e.key === 'Enter' && searchProducts(1, 'auto'));

  initContracts();

  $('#mRun').addEventListener('click', () => loadPerf('auto'));
  loadPerfCorps();
  attachCorpSuggest($('#pfSearch'));
  initYearPicker();
  initPerfCond();
  initPerfSort();
  $('#pfMine').addEventListener('click', addMyCorpsToPerf);
  $('#pfFetch').addEventListener('click', () => fetchCorpFromG2B());
  initDtilPicker();
  ['#pfPeriod', '#pfInsttN'].forEach((id) => $(id).addEventListener('change', () => loadPerf()));

  $('#setKeySave').addEventListener('click', saveKey);
  $('#setMock').addEventListener('change', (e) => save({ forceMock: e.target.checked }));
  $('#setLimitSave').addEventListener('click', () => save({ dailyLimit: Number($('#setLimit').value) }));
  $('#setBaseSave').addEventListener('click', () => save({ baseUrl: $('#setBase').value }));
  $('#setAutoSave').addEventListener('click', async () => {
    await save({ autoFill: $('#setAutoFill').checked, autoFillMaxDays: Number($('#setAutoMax').value) });
    alert('저장했습니다.');
  });
  $('#corpAdd').addEventListener('click', () => addCorpRow({ name: '', bizno: '' }));
  $('#corpSave').addEventListener('click', saveCorps);

  await initMode();
  if (state.viewer) {
    $('#pfFetch').textContent = '관리자에게 가져오기 요청';
    $('#pfFetch').title =
      '넣은 업체명을 관리자 PC 에 보내면, 관리자 PC 가 조달청에서 그 업체의 쇼핑몰 등록품목과 거래내역을 받아 몇 분 뒤 여기에도 들어옵니다.';
  }
  await refreshMeta();
  showTab(location.hash.slice(1) || 'home');
}

/* ── 어느 쪽 프로그램인가 ───────────────────────────────────── */

/** 검색 전용(동료 PC)이면 수집·설정을 숨기고 받은 자료 상태만 보여준다. */
async function initMode() {
  try {
    const who = await api('/whoami');
    state.viewer = Boolean(who.viewer);
    state.mobile = Boolean(who.mobile); // 모바일 검색용 (mobile/worker.js) — 휴대폰 안에서 검색만
  } catch {
    state.viewer = false;
  }
  if (state.viewer) return initViewer();
  initPublish();
  initInbox();
}

/* ── 검색 전용 (동료 PC) ── */

async function initViewer() {
  document.body.classList.add('viewer');
  const tick = async () => {
    try {
      state.feed = await api('/feed/status');
    } catch {
      return;
    }
    if (state.meta) renderBadges();
    if (state.feed.restarting) waitRestart();
  };
  await tick();
  setInterval(tick, 60000);
}

/** 새 기본자료·새 버전으로 다시 켜지는 동안 기다렸다가 새로고침 */
let restartWaiting = false;
async function waitRestart() {
  if (restartWaiting) return;
  restartWaiting = true;
  fillBanner('', '새 자료(또는 새 버전)로 바꾸는 중입니다… 끝나면 자동으로 새로고침합니다. <span class="small muted">처음 받는 큰 자료면 몇 분 걸릴 수 있습니다.</span>');
  await new Promise((r) => setTimeout(r, 5000));
  for (let i = 0; i < 360; i++) {
    try {
      const s = await fetch('/api/feed/status').then((r) => r.json());
      if (!s.restarting) return location.reload();
    } catch {}
    await new Promise((r) => setTimeout(r, 5000));
  }
}

/* ── 동료 배포 (관리자 PC) ── */

function initPublish() {
  $('#pubEnable').addEventListener('change', async (e) => {
    try {
      renderPublish(await api('/publish/enable', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: e.target.checked }) }));
      if (e.target.checked && !state.pub?.base) await publishRun(false);
    } catch (err) {
      alert(err.message);
    }
  });
  $('#pubNow').addEventListener('click', () => publishRun(false));
  $('#pubBase').addEventListener('click', () => {
    if (confirm('기본자료를 새로 만들까요?\n몇십 초 동안 이 PC 의 화면이 멈출 수 있고, 동료 PC 는 다음에 켤 때 전체 자료(약 50MB 이상)를 다시 받습니다.')) publishRun(true);
  });
  $('#pubZip').addEventListener('click', async () => {
    const link = $('#pubLink').value.trim();
    const btn = $('#pubZip');
    btn.disabled = true;
    btn.textContent = '만드는 중…';
    try {
      const r = await api('/publish/zip', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ link }) });
      renderPublish(r.status);
      alert(`"${r.result.file}" 을(를) 배포 폴더에 만들었습니다 (${Math.round(r.result.size / 1048576)}MB).\n동료에게 배포 폴더 링크를 보내 이 zip 을 받게 하세요.`);
    } catch (err) {
      alert(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = '동료용 프로그램 만들기';
    }
  });
  loadPublish().catch(() => ($('#pubCard').hidden = true));
  setInterval(() => !$('#tab-settings').hidden && loadPublish().catch(() => {}), 30000);
}

async function publishRun(base) {
  const btns = ['#pubNow', '#pubBase'];
  btns.forEach((id) => ($(id).disabled = true));
  $('#pubState').innerHTML = `<span class="badge">${base ? '기본자료 만드는 중… (몇십 초)' : '배포 중…'}</span>`;
  try {
    const r = await api('/publish/now', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ base }) });
    renderPublish(r.status);
  } catch (err) {
    alert(err.message);
    await loadPublish();
  } finally {
    btns.forEach((id) => ($(id).disabled = false));
  }
}

async function loadPublish() {
  renderPublish(await api('/publish/status'));
}

const mb = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + 'MB' : Math.max(1, Math.round(b / 1024)) + 'KB');

function renderPublish(s) {
  state.pub = s;
  $('#pubEnable').checked = s.enabled;
  $('#pubDir').textContent = s.dir;
  if (!$('#pubLink').value && s.link) $('#pubLink').value = s.link;
  const rows = [];
  if (s.base) {
    rows.push(`기본자료 <b>${ymdhm(s.base.createdAt)}</b> · ${mb(s.base.size)}`);
    rows.push(`변경분 ${n(s.patches)}개 · ${mb(s.patchBytes || 0)}`);
    rows.push(s.pending ? `<b>아직 안 보낸 바뀐 줄 ${n(s.pending)}개</b>` : '보낼 것 없음 (최신)');
    if (s.publishedAt) rows.push(`마지막 배포 ${ymdhm(s.publishedAt)}`);
  } else rows.push('아직 배포한 적이 없습니다.');
  if (s.last?.error) rows.push(`<span class="badge warn">오류</span> ${esc(s.last.error)}`);
  $('#pubState').innerHTML =
    (s.enabled ? '<span class="badge ok">자동 배포 켜짐</span> ' : '<span class="badge">꺼짐</span> ') + `<span class="small">${rows.join(' · ')}</span>`;
  $('#pubZipInfo').innerHTML = s.zip ? `<span class="small muted">동료용 프로그램: ${mb(s.zip.size)} · ${ymdhm(s.zip.at)} 만듦</span>` : '';
}

/* ── 동료 요청 받기 (관리자 PC) ───────────────────────────────── */

function initInbox() {
  $('#reqList').addEventListener('click', onInboxClick);
  $('#reqOn').addEventListener('change', (e) => saveInbox({ on: e.target.checked }));
  $('#reqAuto').addEventListener('change', (e) => saveInbox({ auto: e.target.checked }));
  $('#reqSave').addEventListener('click', () => saveInbox({ test: true }));
  loadInbox().catch(() => {});
  // 동료 요청은 OneDrive 로 내려오므로, 화면을 열어 두지 않아도 가끔 훑어본다
  setInterval(() => loadInbox().catch(() => {}), 60000);
}

async function loadInbox() {
  renderInbox(await api('/inbox'));
}

function renderInbox(s) {
  state.inbox = s;
  const news = s.items.filter((r) => r.state === 'new');
  $('#reqCount').textContent = news.length ? `새 요청 ${n(news.length)}건` : '';
  $('#reqCount').hidden = !news.length;
  const nav = $('nav button[data-tab="manage"]');
  if (nav) nav.textContent = news.length ? `수집 · 설정 (${news.length})` : '수집 · 설정';
  $('#reqDir').textContent = s.dir || '(OneDrive 폴더를 찾지 못했습니다)';
  $('#reqOn').checked = s.on;
  $('#reqAuto').checked = s.auto;

  const show = s.items.filter((r) => r.state !== 'hidden').slice(0, 20);
  if (!show.length) {
    $('#reqList').innerHTML = `<p class="small muted">아직 들어온 요청이 없습니다.${
      s.on ? '' : ' 동료가 요청을 보낼 수 있게 하려면 <b>설정 → 동료 배포 → 동료 요청 받기</b> 를 먼저 켜 주세요.'
    }</p>`;
    return;
  }
  $('#reqList').innerHTML = `<div class="tablewrap"><table>
    <thead><tr><th>누가</th><th>무엇을</th><th>기간</th><th>언제</th><th></th></tr></thead>
    <tbody>${show
      .map(
        (r) => `<tr${r.state === 'new' ? '' : ' class="muted"'}>
        <td>${esc(r.who || '-')}</td>
        <td><b>${esc(r.dtil)}</b> <span class="small muted">${esc(r.label)}</span>${
          r.note ? `<br><span class="small muted">${esc(r.note)}</span>` : ''
        }</td>
        <td class="small">${r.dataset === 'corp' ? '<span class="muted">전 기간</span>' : `${ymd(r.day_from)} ~ ${ymd(r.day_to)}`}</td>
        <td class="small">${ymdhm(r.at || r.got_at)}</td>
        <td style="white-space:nowrap">${
          r.state === 'taking'
            ? '<span class="badge">받는 중…</span>'
            : r.state === 'new'
              ? `<button class="btn small primary" data-take="${esc(r.id)}">받기</button>
                 <button class="btn small" data-hide="${esc(r.id)}">지우기</button>`
              : '<span class="small muted">처리함</span>'
        }</td>
      </tr>`
      )
      .join('')}</tbody></table></div>`;
}

async function onInboxClick(e) {
  const take = e.target.dataset.take;
  const hide = e.target.dataset.hide;
  if (!take && !hide) return;
  try {
    if (hide) return renderInbox(await setInboxState(hide, 'hidden'));
    const r = state.inbox.items.find((x) => x.id === take);
    if (!r) return;
    if (r.dataset === 'corp') {
      // 업체 가져오기 — 1분 안팎. 결과 요약은 목록의 메모로 남는다
      e.target.disabled = true;
      e.target.textContent = '받는 중…';
      const res = await api('/inbox/take-corp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: take }),
      });
      renderInbox(res.status);
      return refreshMeta();
    }
    const err = collectFor({ dataset: r.dataset, from: r.day_from, to: r.day_to, dtil: r.dtil });
    if (err) return alert(err);
    renderInbox(await setInboxState(take, 'done'));
  } catch (err) {
    alert(err.message);
    loadInbox().catch(() => {});
  }
}

const setInboxState = (id, st) =>
  api('/inbox/state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, state: st }) });

async function saveInbox(opts) {
  const btn = $('#reqSave');
  btn.disabled = true;
  btn.textContent = '시험 중…';
  notice('#reqLinkInfo', '', '');
  try {
    const s = await api('/inbox/options', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(opts) });
    renderInbox(s);
    if (!s.on) return notice('#reqLinkInfo', '', '동료 요청 받기를 껐습니다.');
    if (!s.link) {
      return notice('#reqLinkInfo', 'warn', '위 <b>배포 폴더 공유 링크</b>를 먼저 넣고 <b>동료용 프로그램 만들기</b>를 눌러 주세요.');
    }
    if (s.probe) {
      notice(
        '#reqLinkInfo',
        s.probe.ok ? '' : 'err',
        s.probe.ok
          ? '동료가 하는 것과 똑같이 쪽지를 한 장 올려 봤고 잘 들어갔습니다. 동료 프로그램은 다음 확인(3분 안)부터 요청을 보낼 수 있습니다.'
          : esc(s.probe.error)
      );
    }
  } catch (err) {
    notice('#reqLinkInfo', 'err', esc(err.message));
    loadInbox().catch(() => {});
  } finally {
    btn.disabled = false;
    btn.textContent = '연결 시험';
  }
}

const ymdhm = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  $('#themeBtn').textContent = t === 'dark' ? '☀️' : '🌙';
  localStorage.setItem('theme', t);
}
const toggleTheme = () =>
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');

/** 창 없이 뒤에서 도는 서버를 끈다. 다시 쓰려면 바탕화면의 G2B Finder 아이콘을 누른다. */
async function quitApp() {
  // 로그인 때 서버가 저절로 켜져 북마크로 여는 경우가 많다 — 끄면 그 북마크가 안 열린다는 걸 먼저 알린다
  const icon = state.viewer ? 'G2B Finder 검색용' : 'G2B Finder';
  const msg =
    'G2B Finder 를 종료할까요?\n\n' +
    '평소에는 끄지 않아도 됩니다 (윈도우 로그인 때 저절로 켜져 뒤에서 기다립니다).\n' +
    `끄면 다음 로그인 전까지는 북마크·작업표시줄로 열리지 않고, 바탕화면의 ${icon} 아이콘을 눌러야 다시 켜집니다.`;
  if (!confirm(msg)) return;
  try {
    await api('/shutdown', { method: 'POST' });
  } catch (err) {
    return alert(err.message);
  }
  document.body.innerHTML = `<main style="padding:48px 16px;text-align:center"><h2>G2B Finder 를 종료했습니다</h2><p class="muted">이 탭은 닫아도 됩니다. 다시 쓰려면 바탕화면의 <b>${icon}</b> 아이콘을 누르세요 (다음 로그인 때는 저절로 켜집니다).</p></main>`;
}

async function refreshMeta() {
  const meta = await api('/meta');
  state.meta = meta;
  state.datasets = meta.datasets;
  state.settings = meta.settings;

  const colSel = $('#colDataset');
  const keep = colSel.value;
  colSel.innerHTML = meta.datasets
    .map((d) => `<option value="${d.id}">${esc(d.label)}</option>`)
    .join('');
  if (keep) colSel.value = keep;
  if (!colSel.dataset.bound) {
    colSel.addEventListener('change', syncCollectFilter);
    colSel.dataset.bound = '1';
  }
  syncCollectFilter();
  const pSel = $('#pDataset');
  pSel.innerHTML =
    '<option value="">전체</option>' +
    meta.datasets
      .filter((d) => d.kind === 'product')
      .map((d) => `<option value="${d.id}">${esc(d.label)}</option>`)
      .join('');

  renderBadges();
  loadSuggestions();
}

function renderBadges() {
  const s = state.settings;
  const mode = $('#modeBadge');
  if (state.viewer) {
    // 검색 전용: API 를 쓰지 않으니 사용량 대신 자료 기준 시각
    const f = state.feed || {};
    mode.textContent = '검색 전용';
    mode.className = 'badge ok';
    mode.title = '관리자 PC 가 배포한 자료로 검색합니다. 새 품목·기간은 관리자 PC 에서 받아야 들어옵니다.';
    const b = $('#usageBadge');
    b.textContent = f.dataAt ? `자료 ${ymdhm(f.dataAt)} 기준` : '자료 확인 중…';
    b.className = 'badge ' + (f.error ? 'warn' : '');
    b.title = f.error ? `배포 폴더 확인 실패: ${f.error}` : `마지막 확인 ${f.lastCheck ? ymdhm(f.lastCheck) : '-'}`;
    return;
  }
  mode.textContent = s.mock ? '샘플 데이터 모드' : '실데이터 (인증키 적용)';
  mode.className = 'badge ' + (s.mock ? 'warn' : 'ok');

  // 한도는 서비스마다 따로다. 배지에는 주로 쓰는 쇼핑몰 서비스를 적고,
  // 마우스를 올리면 모든 서비스를 보여준다.
  const u = state.meta?.usage;
  const limit = s.dailyLimit || 1000;
  const svcs = u?.services || [];
  const shop = svcs.find((x) => x.id === 'shop');
  const used = shop ? shop.used : u?.total || 0;
  const b = $('#usageBadge');
  b.textContent = `오늘 API 쇼핑몰 ${n(used)} / ${n(shop?.limit || limit)}회`;
  b.title = svcs.length
    ? svcs.map((x) => `${x.label} ${n(x.used)} / ${n(x.limit)}회`).join('\n') +
      '\n\n서비스마다 따로 활용신청한 별개의 API 라 하루 한도도 각각 따로입니다.'
    : '';
  b.className = 'badge ' + (svcs.some((x) => x.used > x.limit * 0.9) ? 'warn' : '');
}

/* ── 세부품명·품명 자동완성 ─────────────────────────────────────── */

/**
 * 칸 아래에 뜨는 자동완성 목록 (세부품명·품명·업체·기관·지역 공용).
 * ↑↓ 로 고르고 Enter 로 넣는다 (목록이 떠 있을 때 Enter 는 검색 대신 선택).
 *   fetch(term) → 후보 배열, row(r) → 한 줄 HTML, pick(r) → 골랐을 때,
 *   empty(term) → 후보가 없을 때 문구, enterFirst → 고른 줄 없이 Enter 면 첫 줄을 고른다.
 */
function attachSuggest(input, { fetch, row, pick, empty, enterFirst = false, delay = 120 }) {
  input.setAttribute('autocomplete', 'off');
  input.removeAttribute('list'); // 브라우저 기본 목록과 겹치지 않게
  const host = input.parentElement;
  host.classList.add('ac-host');
  const box = document.createElement('div');
  box.className = 'ac';
  box.hidden = true;
  host.appendChild(box);

  let items = [];
  let active = -1;
  let timer = null;
  let seq = 0;

  const close = () => {
    box.hidden = true;
    active = -1;
  };
  const choose = (i) => {
    const it = items[i];
    if (!it) return;
    close();
    pick(it);
  };
  const paint = () => {
    $$('.ac-item', box).forEach((el, i) => el.classList.toggle('on', i === active));
    $$('.ac-item', box)[active]?.scrollIntoView({ block: 'nearest' });
  };

  const load = async () => {
    const term = input.value.trim();
    if (!term) return close();
    const my = ++seq;
    let rows;
    try {
      rows = await fetch(term);
    } catch {
      return close();
    }
    if (my !== seq) return; // 더 최근 입력의 결과가 우선
    if (document.activeElement !== input) return;
    items = rows;
    active = -1;
    box.innerHTML = rows.length
      ? rows.map((r, i) => `<div class="ac-item" data-i="${i}">${row(r)}</div>`).join('')
      : `<div class="ac-empty">${esc(empty(term))}</div>`;
    box.hidden = false;
  };

  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(load, delay);
  });
  input.addEventListener('focus', () => input.value.trim() && load());
  input.addEventListener('blur', () => setTimeout(close, 150));
  // 캡처 단계에서 먼저 받아, 목록에서 고르는 Enter 가 검색으로 넘어가지 않게 한다.
  input.addEventListener(
    'keydown',
    (e) => {
      if (box.hidden || !items.length) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        paint();
      } else if (e.key === 'Enter' && (active >= 0 || enterFirst)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        choose(active >= 0 ? active : 0);
      } else if (e.key === 'Escape') {
        close();
      }
    },
    true
  );
  box.addEventListener('mousedown', (e) => {
    const el = e.target.closest('.ac-item');
    if (!el) return;
    e.preventDefault(); // blur 로 닫히기 전에 고른다
    choose(Number(el.dataset.i));
  });
}

/** 값을 칸에 넣고 change 를 알린다 */
function fillInput(input, value) {
  input.value = value;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

/** 세부품명·품명 칸 — 조달청 물품분류 목록에서. getKind() 는 'dtil' 또는 'clsfc'. */
function attachItemSuggest(input, getKind) {
  attachSuggest(input, {
    fetch: (term) => api('/items/suggest?' + qs({ kind: getKind(), term, limit: 12 })),
    row: (r) => `
      <span class="ac-name">${esc(r.name)}${r.unused ? ' <span class="muted">(사용 안 함)</span>' : ''}</span>
      <span class="ac-sub">${esc([r.parent && r.parent !== r.name ? r.parent : '', r.code].filter(Boolean).join(' · '))}</span>
      ${r.cnt ? `<span class="ac-cnt">저장 ${n(r.cnt)}건</span>` : ''}`,
    pick: (r) => fillInput(input, r.name),
    empty: () => '맞는 품목이 없습니다',
  });
}

/**
 * 거래내역 값 칸(업체명·업체소재지·수요기관·기관지역) — 저장된 거래내역에서, 금액 큰 순.
 * getDtil() 이 세부품명을 주면 그 품목 거래 안에서만 찾는다.
 */
function attachOrderSuggest(input, field, getDtil = () => '') {
  const what = { corp: '업체가', instt: '수요기관이', rgn: '지역이', corpLoc: '업체소재지가' }[field];
  attachSuggest(input, {
    delay: 180,
    fetch: (term) => api('/suggest/order?' + qs({ field, term, dtil: getDtil(), limit: 12 })),
    row: (r) => `
      <span class="ac-name">${esc(r.value)}</span>
      <span class="ac-sub">${esc(r.sub || '')}</span>
      <span class="ac-cnt">${won(r.amt)}원 · ${n(r.cnt)}줄</span>`,
    pick: (r) => fillInput(input, r.value),
    empty: () => {
      const d = getDtil();
      return d ? `세부품명 "${d}" 거래에 맞는 ${what} 없습니다` : `저장된 거래내역에 맞는 ${what} 없습니다`;
    },
  });
}

/**
 * 등록품목 값 칸(계약업체·업체소재지) — 지금 쇼핑몰에 있는 품목에서, 등록 품목 수가 많은 순.
 * getDtil() 이 세부품명을 주면 그 품목 안에서만 찾는다.
 */
function attachProductSuggest(input, field, getDtil = () => '') {
  const what = { corp: '업체가', loc: '업체소재지가' }[field];
  attachSuggest(input, {
    delay: 180,
    fetch: (term) => api('/suggest/product?' + qs({ field, term, dtil: getDtil(), limit: 12 })),
    row: (r) => `
      <span class="ac-name">${esc(r.value)}</span>
      <span class="ac-sub">${esc(r.sub || '')}</span>
      <span class="ac-cnt">등록 ${n(r.cnt)}개</span>`,
    pick: (r) => fillInput(input, r.value),
    empty: () => {
      const d = getDtil();
      return d ? `세부품명 "${d}" 등록품목에 맞는 ${what} 없습니다` : `저장된 등록품목에 맞는 ${what} 없습니다`;
    },
  });
}

async function loadClsfcInfo() {
  try {
    const s = await api('/items/status');
    $('#clsfcInfo').innerHTML = s.syncing
      ? '목록을 받는 중입니다…'
      : s.dtil
        ? `세부품명 <b>${n(s.dtil)}</b>개 · 품명 <b>${n(s.clsfc)}</b>개 · 받은 날 ${esc((s.syncedAt || '').slice(0, 10))}`
        : `아직 받지 않았습니다${s.error ? ` — <span style="color:var(--danger)">${esc(s.error)}</span>` : ''}`;
    $('#clsfcSync').disabled = s.syncing;
    if (s.syncing) setTimeout(loadClsfcInfo, 2000);
  } catch {
    /* 무시 */
  }
}

async function loadCorpLocInfo() {
  try {
    const s = await api('/corploc/status');
    const pct = s.corps ? Math.round((s.known / s.corps) * 100) : 0;
    const r = s.lastRun;
    const run = s.running
      ? ` · <b>채우는 중</b> ${n(r?.done || 0)} / ${n(r?.total || 0)}곳`
      : r
        ? ` · 마지막: ${n(r.found)}곳 채움${r.fromReg ? ' (받아 둔 조달업체 주소에서, API 호출 없음)' : ''}${r.error ? ` — <span style="color:var(--danger)">${esc(r.error)}</span>` : ''}`
        : '';
    $('#corpLocInfo').innerHTML =
      `거래 업체 ${n(s.corps)}곳 중 <b>${n(s.known)}곳(${pct}%)</b> 소재지 확인 · 남은 업체 ${n(s.pending)}곳` +
      (s.refreshPending ? ` · 옛 지역 이름 확인 남음 ${n(s.refreshPending)}곳` : '') +
      (s.notRegistered ? ` · 조달업체 정보 없음 ${n(s.notRegistered)}곳` : '') +
      run +
      (!s.running && (s.pending || s.refreshPending) && !s.budget ? ' · <span class="muted">오늘 한도 여유가 없어 내일 이어서 합니다</span>' : '');
    $('#corpLocFill').disabled = s.running || !(s.pending || s.refreshPending) || !s.budget;
    if (s.running && !$('#tab-settings').hidden) setTimeout(loadCorpLocInfo, 2000);
  } catch {
    $('#corpLocInfo').textContent = '상태를 불러오지 못했습니다.';
  }
}

async function fillCorpLocNow() {
  $('#corpLocFill').disabled = true;
  try {
    await api('/corploc/fill', { method: 'POST' });
  } catch (err) {
    alert(err.message);
  }
  setTimeout(loadCorpLocInfo, 500);
}

async function syncClsfcNow() {
  $('#clsfcSync').disabled = true;
  try {
    await api('/items/sync', { method: 'POST' });
  } catch (err) {
    alert(err.message);
  }
  setTimeout(loadClsfcInfo, 500);
}

async function loadSuggestions() {
  const map = {
    dlCorp: 'corp',
    dlInstt: 'instt',
    dlRgn: 'rgn',
    dlClsfc: 'clsfc',
    dlDtil: 'dtil',
    dlProductDtil: 'productDtil',
    dlProductCorp: 'productCorp',
  };
  await Promise.all(
    Object.entries(map).map(async ([id, field]) => {
      try {
        const rows = await api('/suggest?' + qs({ field, limit: 30 }));
        $('#' + id).innerHTML = rows.map((r) => `<option value="${esc(r.value)}">`).join('');
      } catch {
        /* 자동완성은 실패해도 그냥 넘어간다 */
      }
    })
  );
}

/* ── 현황 · 수집 ──────────────────────────────────────────────── */

async function loadHome() {
  const ov = await api('/overview');
  $('#homeTiles').innerHTML = tiles([
    { k: '등록품목', v: n(ov.product.count) + '건', u: `${ymd(ov.product.from)} ~ ${ymd(ov.product.to)}` },
    { k: '거래내역(품목줄)', v: n(ov.orderItem.count) + '건', u: `${ymd(ov.orderItem.from)} ~ ${ymd(ov.orderItem.to)}` },
    { k: '거래 금액 합계', v: won(ov.orderItem.amount) + '원', u: `납품요구 ${n(ov.orderHead.count)}건` },
    { k: '수요기관', v: n(ov.orderItem.institutions) + '곳', u: `업체 ${n(ov.orderItem.corps)}곳` },
    ...((ov.coverage || [])
      .filter((c) => c.dataset === 'dlvrDtl')
      .map((c) => ({
        k: '거래내역 저장된 날짜',
        v: n(c.days) + '일',
        u: `${ymd(c.from_day)} ~ ${ymd(c.to_day)} · 이 날짜들은 API 를 다시 부르지 않음`,
      }))),
    ...(ov.mine
      ? [{ k: '내 회사 실적', v: won(ov.mine.amt) + '원', u: `${n(ov.mine.c)}건 · 최근 ${ymd(ov.mine.t)}` }]
      : []),
  ]);

  if (ov.orderItem.count === 0 && ov.product.count === 0) {
    notice(
      '#homeNotice',
      'warn',
      '아직 수집한 자료가 없습니다. 아래 <b>데이터 수집</b> 에서 기간을 정하고 <b>수집 시작</b> 을 눌러주세요.' +
        (state.settings.mock ? ' 지금은 <b>샘플 데이터 모드</b>라 가짜 자료가 들어옵니다.' : '')
    );
  } else {
    notice('#homeNotice', '', '');
  }

  await loadSyncLog();
}

async function loadSyncLog() {
  const { job, recent } = await api('/collect/status');
  renderProgress(job);
  $('#syncTable').innerHTML = tableHtml(
    [
      { label: '시각' },
      { label: '데이터셋' },
      { label: '기간' },
      { label: '받은 건수', num: true },
      { label: '저장', num: true },
      { label: 'API 호출', num: true },
      { label: '건너뜀(일)', num: true },
      { label: '결과' },
    ],
    recent,
    (r) => `<tr>
      <td class="nowrap small">${esc((r.started_at || '').replace('T', ' ').slice(0, 16))}</td>
      <td>${esc(state.datasets.find((d) => d.id === r.dataset)?.label || r.dataset)}</td>
      <td class="nowrap small">${ymd(r.bgn_date)} ~ ${ymd(r.end_date)}</td>
      <td class="num">${n(r.fetched)}</td>
      <td class="num">${n(r.saved)}</td>
      <td class="num">${n(r.api_calls)}</td>
      <td class="num">${n(r.skipped_days)}</td>
      <td class="${r.status === 'ok' || r.status === 'import' ? '' : 'muted'}">${
        r.status === 'ok' ? '완료' + (r.message ? ' · ' + esc(r.message) : '') : r.status === 'import' ? '파일 가져오기 · ' + esc(r.message) : esc(r.message || '실패')
      }</td>
    </tr>`
  );
}

/* ── 파일 가져오기 ─────────────────────────────────────────────── */

async function importFiles(all) {
  const files = all
    .filter((f) => /\.(csv|xlsx|txt)$/i.test(f.name))
    .sort((x, y) => (x.webkitRelativePath || x.name).localeCompare(y.webkitRelativePath || y.name, 'ko'));
  const cover = $('#impCover').checked ? '1' : '0';
  await runImport(
    files.map((f) => ({
      label: f.webkitRelativePath || f.name,
      size: f.size,
      send: async () => {
        // 먼저 앞부분만 읽어 본다. 못 읽으면 서버에 가기 전에 이유를 알려 준다.
        // 파일은 통째로 메모리에 올리지 않고 그대로 보낸다 (수백 MB 파일도 되게)
        try {
          await f.slice(0, 16).arrayBuffer();
        } catch {
          throw new Error('브라우저가 이 파일을 읽지 못했습니다 (OneDrive 클라우드 파일이거나 선택 뒤 바뀐 파일). 아래 "경로에서 가져오기" 를 써 주세요.');
        }
        return api('/import?' + qs({ name: f.webkitRelativePath || f.name, cover }), { method: 'POST', body: f });
      },
    }))
  );
}

/** 폴더 경로를 서버가 직접 읽는다 */
async function importFromPath() {
  const path = $('#impPath').value.trim();
  if (!path) {
    notice('#impProgress', 'warn', '폴더나 파일 경로를 입력하세요.');
    return;
  }
  let scan;
  try {
    scan = await api('/import/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
  } catch (err) {
    notice('#impProgress', 'err', esc(err.message));
    return;
  }
  const cover = $('#impCover').checked;
  await runImport(
    scan.files.map((f) => ({
      label: f.rel,
      size: f.size,
      send: () =>
        api('/import/path', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: f.path, rel: f.rel, cover }),
        }),
    }))
  );
}

async function runImport(files) {
  if (!files.length) {
    notice('#impProgress', 'warn', '가져올 .csv / .xlsx 파일이 없습니다.');
    return;
  }
  const done = [];
  const buttons = ['#impPickFiles', '#impPickDir', '#impPathRun', '#colRun'];
  buttons.forEach((id) => ($(id).disabled = true));
  try {
    for (const [i, f] of files.entries()) {
      const what = `가져오는 중 ${i + 1} / ${files.length} — <b>${esc(f.label)}</b> (${f.size >= 1048576 ? n(Math.round(f.size / 1048576)) + 'MB' : n(Math.round(f.size / 1024)) + 'KB'})`;
      notice('#impProgress', '', what);
      // 큰 파일은 몇 분 걸린다 — 서버가 지금까지 넣은 줄 수를 보여 준다
      const poll = setInterval(async () => {
        const s = await api('/import/status').catch(() => null);
        if (s?.rows) notice('#impProgress', '', `${what} · ${n(s.rows)}줄 넣음 (${n(Math.round((Date.now() - s.startedAt) / 1000))}초)`);
      }, 2000);
      try {
        const r = await f.send();
        done.push({ ...r, file: f.label });
      } catch (err) {
        done.push({ file: f.label, error: err.message === 'Failed to fetch' ? '앱 서버에 연결하지 못했습니다 (서버 창이 닫혔는지 확인).' : err.message });
      } finally {
        clearInterval(poll);
      }
      renderImport(done);
    }
    const ok = done.filter((r) => !r.error);
    const sum = (k) => ok.reduce((s, r) => s + (r[k] || 0), 0);
    const failed = done.length - ok.length;
    notice(
      '#impProgress',
      failed ? 'warn' : '',
      `파일 ${n(ok.length)}개 가져옴 — 새로 ${n(sum('inserted'))}줄, 갱신 ${n(sum('updated'))}줄, API 자료가 있어 둔 것 ${n(sum('keptApi'))}줄 · API 호출 0회` +
        (failed ? ` · <b>실패 ${failed}개</b> (아래 표 참고)` : '')
    );
  } finally {
    buttons.forEach((id) => ($(id).disabled = false));
    loadHome().catch(() => {});
  }
}

function renderImport(list) {
  $('#impTable').innerHTML = tableHtml(
    [
      { label: '파일' },
      { label: '세부품명' },
      { label: '자료 기간' },
      { label: '줄 수', num: true },
      { label: '새로', num: true },
      { label: '갱신', num: true },
      { label: 'API 자료 유지', num: true },
      { label: '받아 둔 날짜 기록' },
    ],
    list,
    (r) =>
      r.error
        ? `<tr><td class="small">${esc(r.file)}</td><td colspan="7" class="muted">실패: ${esc(r.error)}</td></tr>`
        : r.kind === 'product'
          ? `<tr>
      <td class="small">${esc(r.file)}<div class="muted">쇼핑몰 등록품목 · ${esc(r.corpNames.join(', '))}${r.corpCount > r.corpNames.length ? ` 외 ${n(r.corpCount - r.corpNames.length)}곳` : ''}</div></td>
      <td class="small">${esc(Object.entries(r.dtils || {}).map(([k, v]) => `${k} ${n(v)}`).join(', '))}${
        r.dtilCount > Object.keys(r.dtils || {}).length ? ` <span class="muted">외 ${n(r.dtilCount - Object.keys(r.dtils).length)}개</span>` : ''
      }</td>
      <td class="nowrap small">${r.minDate ? `등록 ${ymd(r.minDate)} ~ ${ymd(r.maxDate)}` : '-'}</td>
      <td class="num">${n(r.total)}${r.bad ? ` <span class="muted small">(건너뜀 ${n(r.bad)})</span>` : ''}</td>
      <td class="num">${n(r.inserted)}</td>
      <td class="num">${n(r.updated)}</td>
      <td class="num">${n(r.keptApi)}</td>
      <td class="small">${
        r.corpMarked
          ? r.whole
            ? '쇼핑몰 전체 등록 내역으로 기록 (업체 실적 "전체 품목" 이 등록품목 받기를 묻지 않음)'
            : '업체 전체 등록품목으로 기록 (업체 실적 "전체 품목" 이 다시 받자고 묻지 않음)'
          : '<span class="muted">-</span>'
      }</td>
    </tr>`
          : `<tr>
      <td class="small">${esc(r.file)}</td>
      <td class="small">${esc(Object.entries(r.dtils || {}).map(([k, v]) => `${k} ${n(v)}`).join(', '))}</td>
      <td class="nowrap small">${ymd(r.minDate)} ~ ${ymd(r.maxDate)}</td>
      <td class="num">${n(r.total)}${r.bad ? ` <span class="muted small">(건너뜀 ${n(r.bad)})</span>` : ''}</td>
      <td class="num">${n(r.inserted)}</td>
      <td class="num">${n(r.updated)}</td>
      <td class="num">${n(r.keptApi)}</td>
      <td class="small">${
        r.coverage?.marked
          ? `${ymd(r.coverage.from)} ~ ${ymd(r.coverage.to)}`
          : `<span class="muted">안 함 — ${esc(r.coverage?.reason || '')}</span>`
      }</td>
    </tr>`
  );
}

function renderProgress(job) {
  const box = $('#colProgress');
  if (!job) return (box.innerHTML = '');
  const pct = job.chunkTotal ? Math.round((job.chunkDone / job.chunkTotal) * 100) : 0;
  box.innerHTML = `
    <div class="row small">
      <b>${esc(job.label)}</b>
      <span class="muted">${ymd(job.bgnDate)} ~ ${ymd(job.endDate)}</span>
      <span class="spacer"></span>
      <span>${job.running ? '수집 중…' : job.error ? '중단됨' : '완료'} ${job.chunkDone}/${job.chunkTotal} 구간</span>
    </div>
    <div class="progress" style="margin:6px 0"><i style="width:${pct}%"></i></div>
    <div class="row small muted">
      ${n(job.totalDays)}일 중 ${n(job.skippedDays)}일은 저장돼 있어 건너뜀 · 새로 받을 ${n(job.targetDays)}일 ·
      받은 건수 ${n(job.fetched)} · 저장 ${n(job.saved)} · API 호출 ${n(job.calls)}
      ${job.combo ? ` · 조회구분 ${esc(job.combo.inqryDiv)} / 날짜형식 ${esc(job.combo.dateFormat)}` : ''}
    </div>
    ${job.error ? `<div class="notice err" style="margin-top:8px">${esc(job.error.message)}${job.error.hint ? '<br><span class="small">' + esc(job.error.hint) + '</span>' : ''}</div>` : ''}
    ${job.log?.length ? `<div class="log" style="margin-top:8px">${esc(job.log.join('\n'))}</div>` : ''}
  `;
}

/** 서버 collect.js 의 itemFilterOf 와 같은 규칙 */
function itemFilterOf(ds) {
  if (ds?.filters.includes('dtilPrdctClsfcNoNm')) return 'dtilPrdctClsfcNoNm';
  if (ds?.filters.includes('prdctClsfcNoNm')) return 'prdctClsfcNoNm';
  return null;
}

/** 데이터셋에 따라 필수 칸 이름을 바꾸고, 좁힐 수 없는 데이터셋은 수집 버튼을 막는다. */
function syncCollectFilter() {
  const ds = state.datasets.find((d) => d.id === $('#colDataset').value);
  const need = itemFilterOf(ds);
  $('#colFilterName').textContent = need === 'prdctClsfcNoNm' ? '품명' : '세부품명';
  $('#colFilter').disabled = !need;
  $('#colRun').disabled = !need || !!state.meta?.collecting;
  // 진행 표시와 같은 칸을 쓰므로, 막힘 안내를 띄웠던 경우에만 지운다.
  const box = $('#colProgress');
  if (!need) {
    notice('#colProgress', 'warn', `${esc(ds?.label || '')} 은(는) 품목으로 좁혀 받을 수 없어 수집을 막아 두었습니다.`);
    box.dataset.blocked = '1';
  } else if (box.dataset.blocked) {
    notice('#colProgress', '', '');
    delete box.dataset.blocked;
  }
}

/**
 * 요청 하나를 수집 칸에 채우고 그대로 받기 시작한다.
 * 못 받는 요청이면 까닭을 돌려준다 (받을 수 있으면 null).
 */
function collectFor({ dataset, from, to, dtil }) {
  const ds = state.datasets.find((d) => d.id === dataset);
  if (!ds || !itemFilterOf(ds)) return '이 요청은 품목으로 좁혀 받을 수 없는 자료입니다.';
  $('#colDataset').value = ds.id;
  syncCollectFilter();
  setDate('#colFrom', from);
  setDate('#colTo', to);
  $('#colFilter').value = dtil;
  $('#colSkip').checked = true; // 받아 둔 날짜는 건너뛴다
  $('#colProgress').scrollIntoView({ behavior: 'smooth', block: 'center' });
  startCollect();
  return null;
}

async function startCollect() {
  const bgnDate = dateVal('#colFrom');
  const endDate = dateVal('#colTo');
  if (!bgnDate || !endDate) return alert('수집 기간을 정하세요.');

  const filterText = $('#colFilter').value.trim();
  const ds = state.datasets.find((d) => d.id === $('#colDataset').value);
  const need = itemFilterOf(ds);
  if (!need) return notice('#colProgress', 'warn', `${esc(ds.label)} 은(는) 품목으로 좁혀 받을 수 없어 수집을 막아 두었습니다.`);
  if (!filterText) {
    notice('#colProgress', 'warn', `<b>${need === 'dtilPrdctClsfcNoNm' ? '세부품명' : '품명'}</b>을 넣어야 수집할 수 있습니다. 전체 품목은 하루 API 15회 안팎이 들어 받지 않습니다.`);
    return $('#colFilter').focus();
  }
  const filters = { [need]: filterText };

  $('#colRun').disabled = true;
  try {
    await api('/collect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        datasetId: $('#colDataset').value,
        bgnDate,
        endDate,
        numOfRows: Number($('#colRows').value),
        maxPages: Number($('#colMaxPages').value),
        filters,
        force: !$('#colSkip').checked,
      }),
    });
    pollCollect();
  } catch (err) {
    notice('#homeNotice', 'err', esc(err.message) + (err.hint ? '<br><span class="small">' + esc(err.hint) + '</span>' : ''));
    $('#colRun').disabled = false;
  }
}

function pollCollect() {
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(async () => {
    let job;
    try {
      ({ job } = await api('/collect/status'));
    } catch {
      // 서버가 꺼졌으면 더 묻지 않는다.
      clearInterval(state.pollTimer);
      $('#colRun').disabled = false;
      return notice('#homeNotice', 'err', '서버에 연결할 수 없습니다. start.bat 으로 다시 실행하세요.');
    }
    renderProgress(job);
    if (!job || !job.running) {
      clearInterval(state.pollTimer);
      $('#colRun').disabled = false;
      await refreshMeta();
      await loadHome();
    }
  }, 900);
}

async function diagnose() {
  $('#diagBtn').disabled = true;
  notice('#homeNotice', '', '진단 중…');
  try {
    const r = await api('/diagnose', { method: 'POST' });
    if (r.mock) {
      notice('#homeNotice', 'warn', esc(r.message));
    } else {
      const lines = r.results
        .map(
          (x) =>
            `${x.ok ? '✅' : '❌'} ${esc(x.label)} — ${x.ok ? `총 ${n(x.totalCount)}건 조회 가능` : esc(x.message) + (x.hint ? ` (${esc(x.hint)})` : '')}`
        )
        .join('<br>');
      const allOk = r.results.every((x) => x.ok);
      notice('#homeNotice', allOk ? '' : 'warn', lines);
    }
    await refreshMeta();
  } catch (err) {
    notice('#homeNotice', 'err', esc(err.message));
  } finally {
    $('#diagBtn').disabled = false;
  }
}

/* ── 거래내역 ─────────────────────────────────────────────────── */

function orderQuery() {
  return {
    keyword: $('#oKeyword').value.trim(),
    corp: $('#oCorp').value.trim(),
    bizno: $('#oBizno').value.trim(),
    corpLoc: $('#oCorpLoc').value.trim(),
    instt: $('#oInstt').value.trim(),
    rgn: $('#oRgn').value.trim(),
    clsfc: $('#oClsfc').value.trim(),
    dtil: $('#oDtil').value.trim(),
    from: dateVal('#oFrom'),
    to: dateVal('#oTo'),
    amtMin: $('#oAmtMin').value,
    amtMax: $('#oAmtMax').value,
    sort: $('#oSort').value,
    mine: $('#oMine').checked,
    masYn: $('#oMas').checked ? 'Y' : '',
    exclcYn: $('#oExclc').checked ? 'Y' : '',
    smetprYn: $('#oSme').checked ? 'Y' : '',
  };
}

/**
 * @param {number} page
 * @param {'auto'|'ask'} [fillMode] 있으면 저장 안 된 날짜를 확인한다 (페이지 넘김엔 안 함)
 */
async function searchOrders(page, fillMode) {
  state.orders.page = page;
  const q = { ...orderQuery(), page, size: state.orders.size };
  if (!requireDtil(q.dtil, '#oDtil', ['#oSummary', '#oTable', '#oPager', '#oGroupChart', '#oGroupTable'])) return;
  fillBanner('', '');
  const data = await api('/orders?' + qs(q));
  state.orders.last = data;

  const s = data.summary;
  $('#oSummary').innerHTML = tiles([
    { k: '거래 줄 수', v: n(s.count) + '줄' },
    { k: '합계 금액', v: won(s.amount) + '원', u: s.count ? `줄당 평균 ${won(Math.round(s.amount / s.count))}원` : '' },
    { k: '납품요구서', v: n(s.requests) + '건' },
    { k: '수요기관', v: n(s.institutions) + '곳' },
    { k: '공급업체', v: n(s.corps) + '곳' },
  ]);

  $('#oTable').innerHTML = groupedOrderTable(data.rows);
  bindMarks('#oTable');
  bindHistory('#oTable');
  pager('#oPager', data.total, page, state.orders.size, (p) => searchOrders(p));
  applyOrderView();
  if (orderView() !== 'list') await renderOrderGroup(orderQuery(), s);
  if (fillMode) {
    ensureCoverage({ from: q.from, to: q.to, dtil: q.dtil, mode: fillMode, rerun: () => searchOrders(page) });
  }
}

/* ── 거래내역 목록 그리기 ─────────────────────────────────────── */

/** 변경된 줄에 붙는 표 — 누르면 차수별 이력을 펼친다 */
const chgPill = (r) =>
  r.chg_ord && r.chg_ord !== '00'
    ? ` <button class="pill chg" type="button" data-hist="${esc(r.dlvr_req_no)}|${esc(r.prdct_sno)}"
          title="이 품목은 납품요구가 바뀐 적이 있습니다. 누르면 차수별로 보여줍니다">변경 ${Number(r.chg_ord)}차</button>`
    : '';

const BADGES = [
  ['mas_yn', 'mas', 'MAS'],
  ['exclc_yn', 'exclc', '우수'],
  ['smetpr_yn', 'sme', '중기간'],
];
/** 건 머리줄에 이미 붙인 뱃지(common)는 품목 줄에서 뺀다 */
const badges = (r, common = {}) =>
  BADGES.filter(([k]) => r[k] && !common[k])
    .map(([, c, t]) => ` <span class="pill ${c}">${t}</span>`)
    .join('');

/**
 * 품목 한 줄 — 순번(흐리게) + 규격.
 * 규격은 거의 모두 "세부품명, …" 으로 시작한다(전체의 99.8%). 건의 품명이 하나뿐이라
 * 머리줄에 이미 적어 뒀으면(strip) 그 앞머리를 덜어내고 나머지만 보여준다.
 */
const nameKey = (s) =>
  String(s || '').replace(/\((주|유|재|사)\)|주식회사|유한회사|㈜|[\s.\-·]/g, '');

const itemCell = (r, strip) => {
  let s = String(r.spec_nm || '');
  const head = (r.dtil_clsfc_nm || '') + ',';
  if (strip && s.startsWith(head)) s = s.slice(head.length).trim();
  // 그 다음 토막은 대개 업체 이름이다 — 건 머리줄에 이미 있으니 같은 이름일 때만 덜어낸다
  const i = s.indexOf(',');
  if (i > 0) {
    const t = nameKey(s.slice(0, i));
    const c = nameKey(r.corp_nm);
    if (t && c && (c.includes(t) || t.includes(c))) s = s.slice(i + 1).trim();
  }
  return (
    `<span class="sno">${esc(r.prdct_sno)}</span>` +
    `<span class="it-corp" title="${esc(r.corp_nm)} ${esc(r.corp_bizno)}${
      r.corp_loc ? ' · ' + esc(r.corp_loc) : ''
    }">${esc(r.corp_nm)}</span>` +
    `<span class="it-id" title="물품식별번호 — 나라장터에서 이 물품을 바로 찾을 때 씁니다">${esc(
      r.prdct_idnt_no
    )}</span>` +
    esc(s || r.spec_nm)
  );
};

const markCell = (r) => `
  <td><button class="btn small" data-mark="order" data-key="${esc(r.dlvr_req_no + '-' + r.prdct_sno)}"
        data-title="${esc(r.dtil_clsfc_nm)} / ${esc(r.corp_nm)}"
        data-sub="${esc(r.dminstt_nm)} ${ymd(r.rcpt_date)}">★</button></td>`;

/**
 * 납품요구번호로 묶어서 — 검색 결과는 늘 이렇게 보여준다.
 * 같은 번호가 붙어 있는 만큼을 한 건으로 본다(서버가 어떤 정렬에서도 붙여서 보내준다).
 */
function groupedOrderTable(rows) {
  if (!rows.length) return '<tbody><tr><td class="empty">조건에 맞는 자료가 없습니다.</td></tr></tbody>';
  const groups = [];
  for (const r of rows) {
    const last = groups.at(-1);
    if (last && last.no === r.dlvr_req_no) last.items.push(r);
    else groups.push({ no: r.dlvr_req_no, items: [r] });
  }
  const head = `<colgroup><col /><col class="c-uprc" /><col class="c-qty" />
      <col class="c-amt" /><col class="c-star" /></colgroup>
    <thead><tr><th>품목</th><th class="num">단가</th><th class="num">수량</th>
      <th class="num">금액</th><th></th></tr></thead>`;
  // 결과가 한 가지 세부품명뿐이면(검색 조건이 그렇습니다) 규격 앞머리의 품명을 덜어낸다.
  // 여러 품명이 섞인 결과에서는 품명이 어디에도 없으면 안 되므로 규격에 그대로 둔다.
  const oneDtil = new Set(rows.map((r) => r.dtil_clsfc_nm)).size === 1;
  const body = groups
    .map((g) => {
      const f = g.items[0];
      const amt = g.items.reduce((s, r) => s + (r.amt || 0), 0);
      const changed = g.items.some((r) => r.chg_ord && r.chg_ord !== '00');
      // 건의 품목이 모두 같은 뱃지를 달고 있으면(거의 전부) 머리줄에 한 번만 붙인다
      const common = {};
      for (const [k] of BADGES) if (g.items.every((r) => r[k])) common[k] = true;
      // 납품기한도 건 하나에 하나뿐인 경우가 98.7% — 머리줄에 한 번만 쓰고, 다른 건만 품목 줄에 적는다
      const due = new Set(g.items.map((r) => r.dlvr_tmlmt)).size === 1 ? f.dlvr_tmlmt : '';
      return (
        `<tr class="grp"><td colspan="5">
          <div class="grp-top">
            <b class="grp-no">${esc(g.no)}</b>
            <b class="grp-nm">${esc(f.dlvr_req_nm)}</b>
            <span class="grp-date small muted nowrap" title="납품요구일(조달청 납품요구접수일자) → 납품기한">납품요구 ${ymd(
              f.rcpt_date
            )}${due ? ' → 납품기한 ' + ymd(due) : ''}</span>
            ${badges(common, {})}
            ${changed ? '<span class="pill chg-flat">변경된 건</span>' : ''}
            <span class="small muted grp-cnt">${n(g.items.length)}개 품목</span>
            <b class="grp-amt">${n(amt)}원</b>
          </div>
          <div class="grp-sub muted small" title="발주처 — ${esc(f.dminstt_nm)} (${esc(f.dminstt_rgn)} · ${esc(
            f.dminstt_div
          )})">${esc(f.dminstt_nm)}
            <span class="dim">${esc(f.dminstt_rgn)}</span>
          </div>
        </td></tr>` +
        g.items
          .map(
            (r) => `<tr class="grp-item">
          <td class="spec">${itemCell(r, oneDtil)}${badges(r, common)}${
            due ? '' : `<span class="dim"> · 기한 ${ymd(r.dlvr_tmlmt)}</span>`
          }${chgPill(r)}</td>
          <td class="num nowrap">${n(r.uprc)}</td>
          <td class="num nowrap">${n(Math.round(r.qty))} <span class="dim">${esc(r.unit)}</span></td>
          <td class="num nowrap"><b>${n(r.amt)}</b></td>
          ${markCell(r)}
        </tr>`
          )
          .join('')
      );
    })
    .join('');
  return head + `<tbody>${body}</tbody>`;
}

/* ── 변경 이력 펼치기 ─────────────────────────────────────────── */

function bindHistory(target) {
  $$(`${target} [data-hist]`).forEach((b) =>
    b.addEventListener('click', async () => {
      const tr = b.closest('tr');
      const open = tr.nextElementSibling?.classList.contains('hist');
      // 같은 줄을 다시 누르면 접는다
      $$(`${target} tr.hist`).forEach((x) => x.remove());
      if (open) return;
      const [no, sno] = b.dataset.hist.split('|');
      const cols = tr.children.length;
      const row = document.createElement('tr');
      row.className = 'hist';
      row.innerHTML = `<td colspan="${cols}"><span class="small muted">변경 이력 읽는 중…</span></td>`;
      tr.after(row);
      try {
        const { rows } = await api('/orders/history?' + qs({ no, sno }));
        row.firstElementChild.innerHTML = historyHtml(rows);
      } catch (err) {
        row.firstElementChild.innerHTML = `<span class="small" style="color:var(--danger)">${esc(err.message)}</span>`;
      }
    })
  );
}

function historyHtml(rows) {
  if (!rows.length) return '<span class="small muted">이력이 없습니다.</span>';
  const last = rows.at(-1);
  return `<div class="hist-box">
    <div class="small muted" style="margin-bottom:6px">이 품목의 변경 이력 — 검색·합계에는 <b>맨 아래 최신 차수</b>만 씁니다.</div>
    <table class="hist-tbl">
      <thead><tr><th>차수</th><th>납품요구일</th><th class="num">단가</th><th class="num">수량</th><th class="num">금액</th><th>납품기한</th></tr></thead>
      <tbody>${rows
        .map(
          (r) => `<tr${r === last ? ' class="on"' : ''}>
          <td>${r.chg_ord === '00' ? '원본' : Number(r.chg_ord) + '차'}</td>
          <td class="small">${ymd(r.rcpt_date)}</td>
          <td class="num">${n(r.uprc)}</td>
          <td class="num">${n(Math.round(r.qty))} <span class="muted small">${esc(r.unit)}</span></td>
          <td class="num"><b>${n(r.amt)}</b></td>
          <td class="small">${ymd(r.dlvr_tmlmt)}</td>
        </tr>`
        )
        .join('')}</tbody>
    </table>
  </div>`;
}

/* ── 등록품목 ─────────────────────────────────────────────────── */

function productQuery() {
  return {
    keyword: $('#pKeyword').value.trim(),
    dataset: $('#pDataset').value,
    clsfc: $('#pClsfc').value.trim(),
    dtil: $('#pDtil').value.trim(),
    corp: $('#pCorp').value.trim(),
    loc: $('#pLoc').value.trim(),
    idntNo: $('#pIdnt').value.trim(),
    priceMin: $('#pMin').value,
    priceMax: $('#pMax').value,
    sort: $('#pSort').value,
    masYn: $('#pMas').checked ? 'Y' : '',
    exclcYn: $('#pExclc').checked ? 'Y' : '',
    smetprYn: $('#pSme').checked ? 'Y' : '',
    mine: $('#pMine').checked,
    includeOld: $('#pOld').checked,
  };
}

/**
 * 규격은 거의 모두 "세부품명, 상표, …" 으로 시작한다. 세부품명 머리는 떼고,
 * 그 다음 상표가 계약업체와 같은 이름이면 그것도 뗀다 (업체는 옆 칸에 따로 적으므로). 다른 상표면 남긴다.
 */
function specRest(r) {
  let s = String(r.spec_nm || '');
  const head = (r.dtil_clsfc_nm || '') + ',';
  if (head.length > 1 && s.startsWith(head)) s = s.slice(head.length).trim();
  const i = s.indexOf(',');
  if (i > 0) {
    const t = nameKey(s.slice(0, i));
    const c = nameKey(r.corp_nm);
    if (t && c && (c.includes(t) || t.includes(c))) s = s.slice(i + 1).trim();
  }
  return s || String(r.spec_nm || '');
}

/**
 * 물품 사진 — 조달청 쇼핑몰에 올라온 그림을 그대로 쓴다 (저장하지 않음, 보일 때만 받음).
 * 마우스를 올리면 크게, 누르면 새 창에서 원본. 사진이 없는 품목(조달청 '이미지 없음' 그림)은 빈 칸.
 */
function productThumb(r) {
  const u = String(r.img_url || '');
  if (!/^https:\/\/shop\.g2b\.go\.kr\//.test(u) || /image_non\./.test(u)) return '<span class="thumb none"></span>';
  return `<a class="thumb" href="${esc(u)}" target="_blank" rel="noopener" title="누르면 원본을 새 창에서 엽니다"><img src="${esc(u)}" loading="lazy" alt="" /></a>`;
}

/** 사진에 마우스를 올리면 크게 — 표는 넘치는 부분을 잘라내므로 화면 위에 따로 띄운다 */
function initThumbPreview(scope) {
  const pop = document.createElement('div');
  pop.className = 'thumb-pop';
  pop.hidden = true;
  pop.innerHTML = '<img alt="" />';
  document.body.appendChild(pop);
  const img = pop.firstChild;
  $(scope).addEventListener('mouseover', (e) => {
    const t = e.target.closest('.thumb:not(.none)');
    if (!t) return;
    img.src = t.querySelector('img').src;
    pop.hidden = false;
    const r = t.getBoundingClientRect();
    const h = pop.offsetHeight;
    pop.style.left = Math.min(r.right + 10, innerWidth - pop.offsetWidth - 8) + 'px';
    pop.style.top = Math.max(8, Math.min(r.top + r.height / 2 - h / 2, innerHeight - h - 8)) + 'px';
  });
  $(scope).addEventListener('mouseout', (e) => {
    if (e.target.closest('.thumb') && !e.relatedTarget?.closest?.('.thumb')) pop.hidden = true;
  });
  addEventListener('scroll', () => (pop.hidden = true), { passive: true });
}

/** 지금 쇼핑몰에 없는 품목 표시 (계약 끝난·내려간 품목 포함으로 검색했을 때만 나온다) */
function productStatusPill(r) {
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');
  if (r.delisted) return '<span class="pill">쇼핑몰에서 내려감</span>';
  if (r.cntrct_end && r.cntrct_end < today) return '<span class="pill">계약 종료</span>';
  return '';
}

/**
 * @param {number} page
 * @param {'auto'|'ask'} [fillMode] 있으면 받아 두지 않은 등록품목을 확인한다 (페이지 넘김엔 안 함)
 */
async function searchProducts(page, fillMode) {
  state.products.page = page;
  const pq = productQuery();
  if (!requireProductScope(pq, ['#pCount', '#pTable', '#pPager'])) return;
  fillBanner('', '');
  const data = await api('/products?' + qs({ ...pq, page, size: state.products.size }));
  $('#pCount').innerHTML = `<b>${n(data.total)}</b>건`;
  $('#pTable').innerHTML = tableHtml(
    [
      { label: '품목' },
      { label: '계약업체' },
      { label: '계약단가', num: true },
      { label: '계약기간' },
      { label: '구분' },
      { label: '' },
    ],
    data.rows,
    (r) => `<tr class="prod">
      <td><div class="prod-item">${productThumb(r)}<div>
        <div><b>${esc(r.dtil_clsfc_nm || r.prdct_clsfc_nm)}</b> ${esc(specRest(r))} ${productStatusPill(r)}</div>
        <div class="muted small">식별번호 ${esc(r.prdct_idnt_no)} · ${esc(r.prdct_clsfc_nm)}</div>
      </div></div></td>
      <td>${esc(r.corp_nm)}
        <div class="muted small">${[
          esc(r.entrprs_div),
          r.corp_loc ? `<span class="loc">${esc(r.corp_loc)}</span>` : '소재지 정보 없음',
          r.makr_nm && r.makr_nm !== r.corp_nm ? '제조 ' + esc(r.makr_nm) : '',
          r.fctry ? '공장 ' + esc(r.fctry) : '',
          esc(r.orgplce),
        ].filter(Boolean).join(' · ')}</div>
      </td>
      <td class="num nowrap"><b>${n(r.price)}</b><div class="muted small">${esc(r.unit)}</div></td>
      <td class="nowrap small">${ymd(r.cntrct_bgn)}<div class="muted">~ ${ymd(r.cntrct_end)}</div></td>
      <td>
        <div>${r.cntrct_mthd && r.cntrct_mthd !== '제3자단가계약' ? `<span class="muted small">${esc(r.cntrct_mthd)}</span> ` : ''}${r.mas_yn ? '<span class="pill mas">MAS</span>' : ''}${r.exclc_yn ? '<span class="pill exclc">우수</span>' : ''}${r.smetpr_yn ? '<span class="pill sme">중기간</span>' : ''}</div>
        ${r.cert_list ? `<div class="muted small">${esc(r.cert_list)}</div>` : ''}
      </td>
      <td><button class="btn small" data-mark="product" data-key="${esc(r.cntrct_no + '-' + r.prdct_idnt_no)}"
            data-title="${esc(r.dtil_clsfc_nm)} ${esc(r.spec_nm)}"
            data-sub="${esc(r.corp_nm)} · ${n(r.price)}원">★</button></td>
    </tr>`
  );
  bindMarks('#pTable');
  pager('#pPager', data.total, page, state.products.size, (p) => searchProducts(p));
  if (!pq.dtil) {
    fillBanner(
      'warn',
      `세부품명 없이 업체로 찾아 <b>저장된 등록품목</b>에서만 보여 드립니다.` +
        (state.viewer
          ? ' 이 업체의 품목이 빠져 있으면 <b>업체 실적</b> 탭의 <b>조달청에서 가져오기</b>로 요청할 수 있습니다.'
          : ' 이 업체의 품목이 빠져 있으면 <b>업체 실적</b> 탭의 <b>조달청에서 가져오기</b>로 받을 수 있습니다.')
    );
  }
  // 쇼핑몰 등록품목을 이 세부품명으로 받아 둔 적이 없거나 30일이 지났으면 채운다.
  // API 가 등록일 기준이라 최근 2년 등록분을 받는다 (세부품명으로 좁혀 31일당 약 1회).
  if (fillMode && (!pq.dataset || pq.dataset === 'shop')) {
    ensureCoverage({
      dataset: 'shop',
      from: daysAgo(PRODUCT_FILL_DAYS),
      to: daysAgo(1),
      dtil: pq.dtil,
      mode: fillMode,
      ignoreMaxDays: true,
      rerun: () => searchProducts(page),
    });
  }
}

/** 등록품목을 자동으로 받을 때 거슬러 올라가는 기간 (등록일 기준) */
const PRODUCT_FILL_DAYS = 730;

/* ── 계약 내역 (관리자 PC 만 — 조달청 계약정보) ──────────────────── */

const ct = { page: 1, size: 50, searched: false, poll: null };

function contractQuery() {
  return {
    keyword: $('#ctKeyword').value.trim(),
    instt: $('#ctInstt').value.trim(),
    corp: $('#ctCorp').value.trim(),
    corpLoc: $('#ctCorpLoc').value.trim(),
    kind: $('#ctKind').value,
    method: $('#ctMethod').value,
    from: dateVal('#ctFrom'),
    to: dateVal('#ctTo'),
    amtMin: $('#ctAmtMin').value,
    amtMax: $('#ctAmtMax').value,
    sort: $('#ctSort').value,
  };
}

const ctView = () => $('#ctView').value;

/** 1234567890 → 123-45-67890 */
const fmtBizno = (v) => {
  const s = String(v || '').replace(/[^0-9]/g, '');
  return s.length === 10 ? `${s.slice(0, 3)}-${s.slice(3, 5)}-${s.slice(5)}` : s;
};

/** 받은 자료·받는 중인 것 — 받는 중이면 5초마다 다시 본다 */
async function loadContractStatus() {
  clearTimeout(ct.poll);
  const s = await api('/contracts/status').catch(() => null);
  if (!s) return;
  const el = $('#ctStatus');
  if (s.mock) {
    el.innerHTML = '<span class="muted">샘플 모드에서는 계약 내역을 받지 않습니다. 설정에서 서비스키를 넣어 주세요.</span>';
    return;
  }
  const parts = [`받은 계약 <b>${n(s.rows)}</b>건`];
  parts.push(
    s.daysDone >= s.days - 2
      ? '최근 1년 모두 받음'
      : `최근 1년 중 <b>${n(s.daysDone)}</b>일 받음${s.oldestDone ? ` (${ymd(s.oldestDone)}까지 거슬러 받음)` : ''}`
  );
  parts.push(`오늘 계약정보 API ${n(s.usedToday)} / ${n(s.limit)}회`);
  const reg = s.reg;
  if (reg) {
    parts.push(
      reg.yearsDone >= reg.years
        ? `업체 소재지 ${n(reg.rows)}곳`
        : `업체 소재지 받는 중 ${n(reg.rows)}곳 (등록연도 ${n(reg.yearsDone)} / ${n(reg.years)}년)`
    );
  }
  let tail = '';
  if (s.running) tail = ` <span class="badge ok">받는 중 — ${esc(s.running.step || '준비')} · ${n(s.running.rows)}건</span>`;
  else if (reg?.running) tail = ` <span class="badge ok">받는 중 — ${esc(reg.running.step || '준비')}</span>`;
  else if (s.last?.error) tail = ` <span class="badge warn">지난번 받기 실패: ${esc(s.last.error)}</span>`;
  else if (s.last?.stopped) tail = ` <span class="muted">${esc(s.last.stopped)}</span>`;
  const more = !s.running && s.pending > 0;
  el.innerHTML =
    `<span class="muted">${parts.join(' · ')}</span>${tail}` +
    (more ? ' <button class="btn small" id="ctSync" title="3시간을 기다리지 않고 지금 이어 받습니다">지금 이어 받기</button>' : '');
  if (more) {
    $('#ctSync').addEventListener('click', async () => {
      await api('/contracts/sync', { method: 'POST' });
      setTimeout(loadContractStatus, 1500);
    });
  }
  if ((s.running || reg?.running) && !$('#tab-contracts').hidden) ct.poll = setTimeout(loadContractStatus, 5000);
}

function loadContracts() {
  loadContractStatus();
  if (!ct.searched) searchContracts(1);
}

function applyContractView() {
  const list = ctView() === 'list';
  $('#ctTop').hidden = list;
  $('#ctSort').disabled = !list;
  $('#ctViewHint').textContent = list
    ? ''
    : CT_CLICK[ctView()]
      ? '금액이 큰 순서 · 줄을 누르면 그 계약 목록을 봅니다'
      : '금액이 큰 순서';
}

/** 묶어 보기에서 줄을 누르면 채울 칸 */
const CT_CLICK = { corp: '#ctCorp', instt: '#ctInstt', corpSido: '#ctCorpLoc', corpLoc: '#ctCorpLoc' };

const CT_GROUP_HEAD = {
  corp: '업체', corpSido: '업체소재 시·도', corpLoc: '업체소재지', instt: '계약기관', insttDiv: '기관구분', month: '월', clsfc: '공종·업종', method: '계약방법', kind: '구분',
};

async function searchContracts(page = 1) {
  ct.page = page;
  ct.searched = true;
  const view = ctView();
  const q = contractQuery();
  $('#ctTable').innerHTML = '<tbody><tr><td class="empty">찾는 중…</td></tr></tbody>';
  let data;
  try {
    data = await api('/contracts?' + qs({ ...q, view: view === 'list' ? '' : view, top: $('#ctTop').value, page, size: ct.size }));
  } catch (err) {
    $('#ctTable').innerHTML = `<tbody><tr><td class="empty">${esc(err.message)}</td></tr></tbody>`;
    return;
  }
  $('#ctSummary').innerHTML = tiles([
    { k: '계약 건수', v: n(data.total), u: '건' },
    { k: '계약금액 합계', v: won(data.amt), u: '원' },
    ...(data.groups != null ? [{ k: CT_GROUP_HEAD[view] + ' 수', v: n(data.groups), u: '곳' }] : []),
  ]);
  if (data.regPartial) {
    $('#ctSummary').insertAdjacentHTML(
      'beforeend',
      '<div class="notice warn" style="grid-column: 1 / -1">조달업체 주소를 아직 받는 중이라, 소재지를 모르는 업체의 계약은 빠지거나 "(소재지 모름)"으로 나옵니다. 다 받으면(이틀쯤) 저절로 채워집니다.</div>'
    );
  }

  if (view !== 'list') {
    const total = data.amt || 1;
    const label = (r) => (view === 'month' ? `${String(r.label).slice(0, 4)}-${String(r.label).slice(4)}` : r.label || '(없음)');
    $('#ctTable').innerHTML = tableHtml(
      [
        { label: CT_GROUP_HEAD[view] },
        { label: '건수', num: true },
        { label: '수의계약', num: true },
        { label: '계약금액', num: true },
        { label: '비중', num: true },
      ],
      data.rows,
      (r) => `<tr ${CT_CLICK[view] && r.k ? `class="clickable" data-k="${esc(r.k)}"` : ''}>
        <td>${esc(label(r))}${r.sub ? ` <span class="muted small">${esc(view === 'corp' ? fmtBizno(r.sub) : r.sub)}</span>` : ''}${
          r.loc ? ` <span class="loc small">${esc(r.loc)}</span>` : ''
        }</td>
        <td class="num">${n(r.n)}</td>
        <td class="num">${n(r.sui)} <span class="muted small">${Math.round((r.sui / r.n) * 100)}%</span></td>
        <td class="num nowrap" title="${n(r.amt)}원">${won(r.amt)}</td>
        <td class="num">${((r.amt / total) * 100).toFixed(1)}%</td>
      </tr>`
    );
    $$('#ctTable tr[data-k]').forEach((tr) =>
      tr.addEventListener('click', () => {
        $(CT_CLICK[view]).value = tr.dataset.k;
        $('#ctView').value = 'list';
        applyContractView();
        searchContracts(1);
      })
    );
    $('#ctPager').innerHTML =
      data.groups > data.rows.length
        ? `<span class="small muted">${n(data.groups)}곳 가운데 금액이 큰 ${n(data.rows.length)}곳</span>`
        : '';
    return;
  }

  $('#ctTable').innerHTML = tableHtml(
    [{ label: '계약일' }, { label: '계약명' }, { label: '계약기관' }, { label: '업체' }, { label: '계약금액', num: true }],
    data.rows,
    (r) => `<tr>
      <td class="nowrap small">${ymd(r.cdate)}<div><span class="pill">${esc(r.kind)}</span></div></td>
      <td><a href="${esc(r.url)}" target="_blank" rel="noopener" title="나라장터에서 계약 상세 보기"><b>${esc(r.name)}</b></a>
        <div class="muted small">${[
          `<span class="pill ${r.method === '수의계약' ? 'sme' : 'mas'}">${esc(r.method)}</span>`,
          esc(r.clsfc),
          r.lngtrm && r.lngtrm !== '신규' ? esc(r.lngtrm) : '',
          r.chg && Number(r.chg) > 0 ? `${Number(r.chg)}차 변경` : '',
          esc(r.prd),
        ].filter(Boolean).join(' · ')}</div>
        ${r.base_dtls ? `<div class="muted small" title="${esc(r.law)}">${esc(r.base_dtls)}</div>` : ''}
      </td>
      <td>${esc(r.instt_nm)}
        <div class="muted small">${[esc(r.instt_div), esc(r.dept), esc(r.ofcl), esc(r.tel)].filter(Boolean).join(' · ')}</div>
        ${r.dmnd ? `<div class="muted small">수요기관 ${esc(r.dmnd)}</div>` : ''}
      </td>
      <td>${esc(r.corp_nm)}
        <div class="muted small">${r.corp_loc ? `<span class="loc">${esc(r.corp_loc)}</span> · ` : ''}${fmtBizno(r.corp_bizno)}${
          r.corp_n > 1 ? ` · <span title="${esc(r.corps)}">${esc(r.joint)} ${n(r.corp_n)}곳</span>` : ''
        }</div>
      </td>
      <td class="num nowrap"><b title="${n(r.amt)}원">${won(r.amt)}</b>${
        r.thtm_amt && r.thtm_amt !== r.amt ? `<div class="muted small">금차 ${won(r.thtm_amt)}</div>` : ''
      }</td>
    </tr>`
  );
  pager('#ctPager', data.total, page, ct.size, (p) => searchContracts(p));
}

function initContracts() {
  const resetDates = () => {
    $('#ctFrom').value = daysAgo(365);
    $('#ctTo').value = daysAgo(0);
  };
  resetDates();
  $('#ctSearch').addEventListener('click', () => searchContracts(1));
  for (const id of ['#ctKeyword', '#ctInstt', '#ctCorp', '#ctCorpLoc', '#ctAmtMin', '#ctAmtMax']) {
    $(id).addEventListener('keydown', (e) => e.key === 'Enter' && searchContracts(1));
  }
  for (const id of ['#ctKind', '#ctMethod', '#ctSort', '#ctTop']) {
    $(id).addEventListener('change', () => searchContracts(1));
  }
  $('#ctView').addEventListener('change', () => {
    applyContractView();
    searchContracts(1);
  });
  $('#ctReset').addEventListener('click', () => {
    for (const id of ['#ctKeyword', '#ctInstt', '#ctCorp', '#ctCorpLoc', '#ctAmtMin', '#ctAmtMax', '#ctKind', '#ctMethod']) $(id).value = '';
    resetDates();
    searchContracts(1);
  });
  $('#ctCsv').addEventListener('click', () => openExport('/api/export?' + qs({ kind: 'contracts', ...contractQuery() })));
  applyContractView();
}

/* ── 물품비교 (관심목록 탭에서 체크한 물품의 비교표) ─────────────── */

const CMP_MAX = 8;
/** picked: 체크한 관심목록 id — 관심목록 탭에서 고르고 물품비교 탭에서 본다 (이 PC 브라우저에 기억) */
const cmp = { picked: [] };

function loadCmpPicked() {
  try {
    cmp.picked = JSON.parse(localStorage.getItem('cmpIds') || '[]').map(Number).filter(Boolean);
  } catch {
    cmp.picked = [];
  }
}
function saveCmpPicked() {
  try {
    localStorage.setItem('cmpIds', JSON.stringify(cmp.picked));
  } catch {}
}

const cmpGroup = (x) => (x.missing ? '(찾지 못한 물품)' : x.dtil_clsfc_nm || '(세부품명 없음)');

function loadCompare() {
  loadCmpPicked();
  renderCmpTable();
}

async function renderCmpTable() {
  const el = $('#cmpTable');
  $('#cmpCount').textContent = cmp.picked.length ? `${n(cmp.picked.length)}개 비교 중 (최대 ${CMP_MAX}개)` : '';
  if (!cmp.picked.length) {
    el.innerHTML = '<tbody><tr><td class="empty"><b>관심목록</b> 탭에서 비교할 물품을 체크하고 <b>비교하기</b> 를 누르면 여기에 비교표가 만들어집니다.</td></tr></tbody>';
    return;
  }
  let items = await api('/compare?' + qs({ ids: cmp.picked.join(',') }));
  // 관심목록에서 지운 물품은 고른 목록에서도 뺀다
  const gone = items.filter((x) => x.missing && !x.kind).map((x) => x.id);
  if (gone.length) {
    cmp.picked = cmp.picked.filter((id) => !gone.includes(id));
    saveCmpPicked();
    return renderCmpTable();
  }
  const ok = items.filter((x) => !x.missing);
  const prices = ok.map((x) => x.price).filter((v) => v > 0);
  const low = prices.length ? Math.min(...prices) : 0;
  const pct = (v, base) => (base > 0 ? Math.round(((v - base) / base) * 1000) / 10 : 0);
  const badges = (x) =>
    [x.mas_yn && '<span class="pill mas">MAS</span>', x.exclc_yn && '<span class="pill exclc">우수</span>', x.smetpr_yn && '<span class="pill sme">중기간</span>']
      .filter(Boolean)
      .join(' ');
  // [항목 이름, 칸 값(html), 같은지 비교할 값]
  const ROWS = [
    ['사진', (x) => productThumb(x).replace('class="thumb"', 'class="thumb big"').replace('class="thumb none"', 'class="thumb big none"'), () => ''],
    ['세부품명', (x) => `<b>${esc(x.dtil_clsfc_nm)}</b>`, (x) => x.dtil_clsfc_nm],
    ['규격', (x) => esc(specRest(x)), (x) => specRest(x)],
    ['물품식별번호', (x) => esc(x.prdct_idnt_no), (x) => x.prdct_idnt_no],
    ['계약업체', (x) => `${esc(x.corp_nm)}<div class="muted small">${esc(x.corp_bizno)}</div>`, (x) => x.corp_bizno],
    ['업체소재지', (x) => esc(x.corp_loc), (x) => x.corp_loc],
    ['제조사', (x) => esc(x.makr_nm), (x) => x.makr_nm],
    ['기업구분', (x) => esc(x.entrprs_div), (x) => x.entrprs_div],
    [
      '계약단가',
      (x) =>
        x.price > 0
          ? `<b>${n(x.price)}원</b> <span class="muted small">/ ${esc(x.unit)}</span><div class="small">${
              ok.length > 1 ? (x.price === low ? '<span class="pill chg-flat">최저</span>' : `최저보다 <b>+${pct(x.price, low)}%</b>`) : ''
            }</div>`
          : '',
      (x) => x.price,
    ],
    ['계약기간', (x) => (x.cntrct_end ? `${ymd(x.cntrct_bgn)} ~ ${ymd(x.cntrct_end)}` : ''), (x) => x.cntrct_bgn + x.cntrct_end],
    [
      '구분',
      (x) => badges(x) + (x.cntrct_mthd && x.cntrct_mthd !== '제3자단가계약' ? ` <span class="muted small">${esc(x.cntrct_mthd)}</span>` : ''),
      (x) => badges(x) + x.cntrct_mthd,
    ],
    ['인증', (x) => esc(x.cert_list), (x) => x.cert_list],
    ['납품기한', (x) => (x.dlvr_days ? `${n(x.dlvr_days)}일` : ''), (x) => x.dlvr_days],
    ['공급지역', (x) => esc(x.sply_rgn), (x) => x.sply_rgn],
    ['원산지', (x) => esc(x.orgplce), (x) => x.orgplce],
    [
      '실거래 건수',
      (x) => (x.deals.reqs ? `${n(x.deals.reqs)}건 <span class="muted small">· ${n(x.deals.instts)}개 기관</span>` : '<span class="muted">저장된 거래 없음</span>'),
      (x) => x.deals.reqs,
    ],
    ['실거래 금액', (x) => (x.deals.amt ? `${n(x.deals.amt)}원 <span class="muted small">(${won(x.deals.amt)}원)</span>` : ''), (x) => x.deals.amt],
    [
      '실거래 평균단가',
      (x) =>
        x.deals.avg
          ? `${n(x.deals.avg)}원${x.price > 0 ? ` <span class="muted small">(계약단가 ${pct(x.deals.avg, x.price) > 0 ? '+' : ''}${pct(x.deals.avg, x.price)}%)</span>` : ''}` +
            (x.deals.umin !== x.deals.umax ? `<div class="muted small">${n(x.deals.umin)} ~ ${n(x.deals.umax)}원</div>` : '')
          : '',
      (x) => x.deals.avg,
    ],
    ['최근 거래', (x) => (x.deals.last ? ymd(x.deals.last) : ''), (x) => x.deals.last],
    [
      '상태',
      (x) => (x.listed ? '쇼핑몰에 있음' : x.delisted ? '<span class="pill">계약 끝남·내려감</span>' : '<span class="muted">등록품목 정보 없음 (거래에서 담음)</span>'),
      (x) => String(x.listed) + x.delisted,
    ],
    ['메모', (x) => esc(x.memo), (x) => x.memo],
  ];

  const head = `<thead><tr><th class="cmp-k"></th>${items
    .map((x) => `<th>${x.missing ? esc(x.title || '') : ''}<button class="btn small" data-unpick="${x.id}" title="비교에서 빼기">빼기</button></th>`)
    .join('')}</tr></thead>`;
  const body = ROWS.map(([label, cell, key]) => {
    const vals = ok.map((x) => cell(x));
    // 모두 비었으면 줄을 뺀다
    if (vals.every((v) => !String(v).replace(/<[^>]+>/g, '').trim() && !/<img/.test(v))) return '';
    const keys = ok.map((x) => String(key(x) ?? ''));
    const same = ok.length > 1 && label !== '사진' && keys.every((k) => k === keys[0]);
    return `<tr class="${same ? 'cmp-same' : ''}"><th class="cmp-k">${label}</th>${items
      .map((x) => (x.missing ? `<td class="muted small">${label === '세부품명' ? esc(x.missing) : ''}</td>` : `<td>${cell(x)}</td>`))
      .join('')}</tr>`;
  }).join('');
  el.innerHTML = head + `<tbody>${body}</tbody>`;
  $$('#cmpTable [data-unpick]').forEach((b) =>
    b.addEventListener('click', () => {
      cmp.picked = cmp.picked.filter((x) => x !== Number(b.dataset.unpick));
      saveCmpPicked();
      renderCmpTable();
    })
  );
}

/* ── 거래내역 · 묶어 보기 (예전 집계분석) ─────────────────────── */

const orderView = () => $('#oView').value;

/** 보기 선택에 맞춰 목록/묶음 영역과 보조 컨트롤을 바꾼다 */
function applyOrderView() {
  const v = orderView();
  const grouped = v !== 'list';
  const time = v === 'month' || v === 'year';
  $('#oList').hidden = grouped;
  $('#oGroup').hidden = !grouped;
  $('#oGroupN').hidden = !grouped || time;
  $('#oSort').disabled = grouped;
  $('#oViewHint').textContent = grouped
    ? '위 검색 조건 전체를 묶은 합계입니다. 비중은 조건 전체 금액 대비입니다.'
    : '한 건의 품목이 페이지 끝에 걸리면 다음 쪽으로 이어집니다.';
  try {
    localStorage.setItem('orderView', v);
    localStorage.setItem('orderGroupN', $('#oGroupN').value);
  } catch {}
}

async function renderOrderGroup(q, summary) {
  const by = orderView();
  const data = await api('/aggregate?' + qs({ ...q, by, limit: $('#oGroupN').value }));
  state.orders.group = data;
  const time = by === 'month' || by === 'year';

  // 기간 묶음은 막대 그래프로 흐름을, 나머지는 표 안의 비중 막대로 순위를 본다.
  const chart = $('#oGroupChart');
  chart.hidden = !time;
  if (time) {
    verticalBars(chart, data.rows.map((r) => r.bucket), [{ slot: 1, name: '금액', values: data.rows.map((r) => r.amt) }], by);
  }

  const total = data.totalAmt || summary.amount || 0;
  const max = Math.max(1, ...data.rows.map((r) => r.amt));
  const pct = (v) => (total ? ((v / total) * 100).toFixed(1) : '0.0') + '%';
  const rank = !time;
  let html = tableHtml(
    [
      ...(rank ? [{ label: '순위', num: true }] : []),
      { label: data.label },
      { label: '금액', num: true },
      { label: by === 'corp' ? '점유율' : '비중' },
      { label: '거래 줄', num: true },
      { label: '납품요구', num: true },
      { label: '수량', num: true },
    ],
    data.rows,
    (r, i) => `<tr>
      ${rank ? `<td class="num muted">${i + 1}</td>` : ''}
      <td>${esc(fmtBucket(by, r.bucket))}</td>
      <td class="num nowrap"><b>${n(r.amt)}</b><div class="muted small">${won(r.amt)}원</div></td>
      <td style="min-width:140px">
        <div class="bar"><i style="width:${Math.round((r.amt / max) * 100)}%"></i></div>
        <div class="muted small">${pct(r.amt)}</div>
      </td>
      <td class="num">${n(r.cnt)}</td>
      <td class="num">${n(r.reqs)}</td>
      <td class="num">${n(Math.round(r.qty))}</td>
    </tr>`
  );
  if (data.rows.length && data.rest && data.rest.buckets > 0) {
    html += `<tfoot><tr class="muted">
      ${rank ? '<td></td>' : ''}<td>그 외 ${n(data.rest.buckets)}${by === 'corp' || by === 'instt' ? '곳' : '개'}</td>
      <td class="num nowrap">${n(data.rest.amt)}<div class="small">${won(data.rest.amt)}원</div></td>
      <td class="small">${pct(data.rest.amt)}</td><td class="num">${n(data.rest.cnt)}</td><td></td><td></td></tr></tfoot>`;
  }
  $('#oGroupTable').innerHTML = html;
}

/** 묶어 보기 결과를 CSV 로 (엑셀에서 바로 열리게 UTF-8 BOM) */
function downloadGroupCsv() {
  const d = state.orders.group;
  if (!d || !d.rows.length) return alert('먼저 검색하세요.');
  const total = d.totalAmt || 0;
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [[d.label, '금액', '비중(%)', '거래 줄', '납품요구', '수량'].map(cell).join(',')];
  for (const r of d.rows) {
    lines.push([fmtBucket(d.by, r.bucket), r.amt, total ? ((r.amt / total) * 100).toFixed(2) : 0, r.cnt, r.reqs, Math.round(r.qty)].map(cell).join(','));
  }
  if (d.rest && d.rest.buckets > 0) lines.push([`그 외 ${d.rest.buckets}`, d.rest.amt, total ? ((d.rest.amt / total) * 100).toFixed(2) : 0, d.rest.cnt, '', ''].map(cell).join(','));
  const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `거래내역_${d.label}별_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function fmtBucket(by, v) {
  if (by === 'month' && String(v).length === 6) return `${String(v).slice(0, 4)}-${String(v).slice(4, 6)}`;
  return v;
}

/* ── 내 실적 ──────────────────────────────────────────────────── */

/* ── 실적 (업체를 골라 비교) ─────────────────────────────────────── */

/*
 * 고른 업체 목록. 업체마다 색 칸(slot 1~8)을 붙여 두고, 다른 업체를 빼도 남은 업체의 색은 그대로 둔다
 * (색은 순위가 아니라 업체를 따라간다). 이 브라우저에만 기억한다.
 */
const PERF_MAX = 8;
/**
 * 한 그래프에 따로 그리는 업체 수. 색은 8개(PERF_MAX)라 9·10번째 업체는 새 색을 만들지 않고
 * 무채색 두 단계(--s9·--s10)를 쓴다 — 범례·막대 툴팁·표로 함께 구분된다.
 * 이보다 많으면 상위 7곳 + '그 외' 로 합친다.
 */
const PERF_CORPS_MAX = 10;
// corps: 사용자가 추가한 업체, view: 지금 비교 중인 업체 (추가한 업체 또는 조건에 맞는 상위 업체)
/** dtils: 기간별 실적에서 체크한 품목 (체크한 순서 = 색 순서) */
const perf = { corps: [], view: [], years: new Set(), market: null, dtils: [], scope: 'cond', scopeAll: false };
/** 기간별 실적에서 한 번에 따로 그릴 수 있는 품목 수 (색 8개) */
const PF_DTIL_MAX = 8;

function loadPerfCorps() {
  try {
    perf.corps = JSON.parse(localStorage.getItem('perfCorps') || '[]').slice(0, PERF_CORPS_MAX);
  } catch {
    perf.corps = [];
  }
}

function savePerfCorps() {
  try {
    localStorage.setItem('perfCorps', JSON.stringify(perf.corps));
  } catch {
    /* 저장이 안 돼도 이번 화면에서는 쓴다 */
  }
}

function addPerfCorp(c) {
  const bizno = String(c.bizno || '').replace(/[^0-9]/g, '');
  if (!bizno || perf.corps.some((x) => x.bizno === bizno)) return false;
  if (perf.corps.length >= PERF_CORPS_MAX) {
    alert(`업체는 최대 ${PERF_CORPS_MAX}곳까지 비교할 수 있습니다.`);
    return false;
  }
  const used = new Set(perf.corps.map((x) => x.slot));
  let slot = 1;
  while (used.has(slot)) slot++;
  perf.corps.push({ bizno, name: c.name || bizno, slot });
  savePerfCorps();
  return true;
}

/**
 * 업체가 8곳 이하로 줄었는데 9·10번 자리(무채색)에 남은 업체가 있으면 빈 색 자리로 옮긴다.
 * 1~8번 색을 가진 업체는 그대로 둔다 (색은 업체를 따라간다).
 */
function compactPerfSlots() {
  if (perf.corps.length > PERF_MAX || !perf.corps.some((c) => c.slot > PERF_MAX)) return;
  const used = new Set(perf.corps.map((c) => c.slot));
  for (const c of perf.corps) {
    if (c.slot <= PERF_MAX) continue;
    let slot = 1;
    while (used.has(slot)) slot++;
    used.delete(c.slot);
    used.add(slot);
    c.slot = slot;
  }
  savePerfCorps();
}

const swatch = (slot) => `<i class="sw" style="background:var(--s${slot})"></i>`;

function renderPerfChips() {
  // 업체를 안 고르고 조건만 넣었을 때 — 조건에 맞는 상위 업체 (📌 로 비교 목록에 고정)
  if (!perf.corps.length && perf.view.some((c) => c.auto)) {
    const m = perf.market;
    $('#pfChips').innerHTML =
      `<span class="muted small">조건에 맞는 업체 ${n(m?.corps || 0)}곳 (합계 ${won(m?.amt || 0)}원) 가운데 ${
        perf.view.length >= (m?.corps || 0) ? '전부' : `상위 ${n(perf.view.length)}곳`
      }${m?.listedOnly ? ` + 이 기간 납품은 없고 쇼핑몰에 등록된 업체 ${n(m.listedOnly)}곳` : ''} ·
        📌 를 누르면 비교 목록에 고정합니다 (고정한 업체가 있으면 그 업체만 비교)</span><br>` +
      perf.view
        .slice(0, perf.view.length > PERF_CORPS_MAX ? PERF_MAX - 1 : PERF_CORPS_MAX)
        .map(
          (c) =>
            `<span class="corp-chip auto">${swatch(c.slot)}${esc(c.name)} <span class="muted small">${esc(c.bizno)}</span>
              <button class="x pin" data-bizno="${esc(c.bizno)}" title="비교 목록에 고정">📌</button></span>`
        )
        .join('') +
      (perf.view.length > PERF_CORPS_MAX
        ? `<span class="corp-chip auto">${swatch(PERF_MAX)}그 외 ${n(perf.view.length - PERF_MAX + 1)}곳 <span class="muted small">아래 표에 모두 있습니다</span></span>`
        : '');
    $$('#pfChips .pin').forEach((b) =>
      b.addEventListener('click', () => {
        const c = perf.view.find((x) => x.bizno === b.dataset.bizno);
        if (c && addPerfCorp(c)) loadPerf('auto');
      })
    );
    return;
  }
  $('#pfChips').innerHTML = perf.corps.length
    ? perf.corps
        .map(
          (c) =>
            `<span class="corp-chip">${swatch(c.slot)}${esc(c.name)} <span class="muted small">${esc(c.bizno)}</span>
              <button class="x" data-bizno="${esc(c.bizno)}" title="빼기">×</button></span>`
        )
        .join('')
    : '<span class="muted small">위 칸에서 업체를 검색해 추가하거나, 세부품명·업체소재지·기관지역 조건만 넣어 상위 업체를 보세요. 설정에 등록한 내 회사는 "내 회사 불러오기" 로 한 번에 넣을 수 있습니다.</span>';
  $$('#pfChips .x').forEach((b) =>
    b.addEventListener('click', () => {
      perf.corps = perf.corps.filter((x) => x.bizno !== b.dataset.bizno);
      savePerfCorps();
      loadPerf();
    })
  );
}

/** 실적 탭 업체 검색 칸 — 고르면 비교 목록에 추가 */
function attachCorpSuggest(input) {
  attachSuggest(input, {
    delay: 150,
    enterFirst: true,
    fetch: (term) => api('/perf/corps?' + qs({ term, limit: 12 })),
    row: (r) => `
      <span class="ac-name">${esc(r.name)}</span>
      <span class="ac-sub">${esc(r.bizno)} · ${r.last ? `최근 ${ymd(r.last)}` : '저장된 거래 없음'}</span>
      <span class="ac-cnt">${r.last ? `${won(r.amt)}원` : `등록 ${n(r.listed)}개`}</span>`,
    pick: (r) => {
      // 고른 이름은 칸에 남겨 둔다 — 바로 "조달청에서 가져오기" 를 누를 수 있게.
      // 글자를 모두 골라 둬서, 다음 업체를 치면 그대로 덮어쓴다.
      input.value = r.name;
      input.select();
      if (addPerfCorp(r)) loadPerf('auto');
    },
    empty: () => '저장된 거래내역·등록품목에 맞는 업체가 없습니다 — "조달청에서 가져오기" 로 받아 올 수 있습니다',
  });
}

function addMyCorpsToPerf() {
  const mine = state.settings.myCorps || [];
  if (!mine.length) return alert('수집 · 설정 → 설정의 내 회사에 등록된 회사가 없습니다.');
  let added = 0;
  for (const c of mine) if (c.bizno && addPerfCorp({ bizno: c.bizno, name: c.name })) added++;
  if (!added && mine.some((c) => !c.bizno)) alert('사업자등록번호가 있는 회사만 불러올 수 있습니다.');
  loadPerf('auto');
}

/* ── 차트 (SVG) ── */

/** 툴팁·표에 쓰는 전체 이름: "2026년 3월", "2026년 1분기" */
const fmtBucketLabel = (by, b) =>
  by === 'month' && /^\d{6}$/.test(b)
    ? `${b.slice(0, 4)}년 ${Number(b.slice(4, 6))}월`
    : by === 'quarter' && /^\d{4}Q\d$/.test(b)
      ? `${b.slice(0, 4)}년 ${b.slice(5)}분기`
      : b || '(없음)';

/**
 * 그래프 가로축은 두 줄로: 윗줄은 "3월"·"1분기", 아랫줄은 해가 바뀔 때만 "2026년".
 * → { year, sub, first } (sub 는 윗줄 글자, first 는 그 해의 첫 칸인지)
 */
function splitPeriod(by, b, prev) {
  const m = by === 'month' && /^\d{6}$/.test(b) ? Number(b.slice(4, 6)) : by === 'quarter' && /^\d{4}Q\d$/.test(b) ? Number(b.slice(5)) : null;
  if (m == null) return null;
  const year = b.slice(0, 4);
  return { year, n: m, sub: by === 'month' ? `${m}월` : `${m}분기`, first: !prev || prev.slice(0, 4) !== year };
}

function vizLegend(target, series) {
  // 업체가 둘 이상일 때만 범례를 단다 (하나면 제목과 표가 이름을 말해 준다)
  $(target).innerHTML =
    series.length > 1 ? series.map((s) => `<span>${swatch(s.slot)}${esc(s.name)}</span>`).join('') : '';
}

let vizTip = null;
function bindVizTip(root) {
  if (!vizTip) {
    vizTip = document.createElement('div');
    vizTip.className = 'viz-tip';
    vizTip.hidden = true;
    document.body.appendChild(vizTip);
  }
  root.addEventListener('mousemove', (e) => {
    const m = e.target.closest('[data-tip]');
    if (!m) return (vizTip.hidden = true);
    vizTip.innerHTML = m.dataset.tip;
    vizTip.hidden = false;
    const x = Math.min(e.clientX + 14, window.innerWidth - vizTip.offsetWidth - 8);
    vizTip.style.left = x + 'px';
    vizTip.style.top = e.clientY + 14 + 'px';
  });
  root.addEventListener('mouseleave', () => (vizTip.hidden = true));
}

/** 둥근 끝(4px)이 바깥쪽, 기준선 쪽은 각진 막대 */
function barPath(x, y, w, h, horizontal) {
  const r = Math.min(4, w / 2, h / 2);
  if (h <= 0 || w <= 0) return '';
  if (horizontal) {
    return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`;
  }
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

/** 축 눈금: 1·2·2.5·5 배수 간격으로 4칸 안팎 → { top, step } */
function niceScale(v) {
  if (!(v > 0)) return { top: 1, step: 0.25 };
  const raw = v / 4;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / p;
  const step = (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
  return { top: Math.ceil(v / step) * step, step };
}

/** 여러 업체를 합친 막대의 툴팁 — 업체별 금액 (큰 순) */
function tipParts(parts) {
  if (!parts || parts.length < 2) return '';
  let list = parts.filter((p) => p.amt).sort((a, b) => b.amt - a.amt);
  // 업체가 많으면 툴팁이 화면을 덮으므로 10곳 넘으면 7곳까지만 이름을 쓰고 나머지는 합친다
  if (list.length > PERF_CORPS_MAX) {
    const rest = list.slice(PERF_MAX - 1);
    list = [...list.slice(0, PERF_MAX - 1), { name: `그 외 ${n(rest.length)}곳`, amt: rest.reduce((a, p) => a + p.amt, 0) }];
  }
  return (
    '<br><span class=&quot;muted&quot;>' +
    list.map((p) => `· ${esc(esc(p.name))} ${won(p.amt)}원`).join('<br>') +
    '</span>'
  );
}

/** 세로 묶음 막대 — 기간별 실적. 구간이 많으면 옆으로 스크롤된다. */
function verticalBars(el, cats, series, by) {
  if (!cats.length) return (el.innerHTML = '<div class="empty">조건에 맞는 자료가 없습니다.</div>');
  const k = series.length;
  const padL = 56;
  const twoRow = by === 'month' || by === 'quarter';
  const padB = twoRow ? 44 : 28;
  const H = twoRow ? 276 : 260;
  // 화면 너비에 맞춰 막대 굵기를 정하고, 6px 보다 가늘어져야 할 만큼 구간이 많을 때만 옆으로 스크롤한다.
  const avail = Math.max(300, (el.clientWidth || 600) - padL - 10);
  const barW = Math.max(6, Math.min(22, (avail / cats.length - 14 - (k - 1) * 2) / k));
  const groupW = k * barW + (k - 1) * 2 + 14;
  const W = Math.max(el.clientWidth || 600, padL + cats.length * groupW + 10);
  const { top: max, step: tick } = niceScale(Math.max(...series.flatMap((s) => s.values)));
  const y = (v) => 8 + (H - padB - 8) * (1 - v / max);
  let svg = '';
  for (let i = 0; i * tick <= max + 1e-9; i++) {
    const v = tick * i;
    svg += `<line class="grid" x1="${padL}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/>`;
    svg += `<text class="tick" x="${padL - 6}" y="${y(v) + 4}" text-anchor="end">${won(v)}</text>`;
  }
  const step = Math.max(1, Math.ceil(cats.length / Math.floor((W - padL) / 44)));
  // 두 줄 축: 칸이 좁으면 1·2·3·6월(분기는 1·2분기) 간격으로 1월(1분기)부터 맞춰 찍는다.
  const subStep = by === 'month' ? [1, 2, 3, 6, 12].find((s) => s >= step) || 12 : Math.min(4, step <= 1 ? 1 : step <= 2 ? 2 : 4);
  // 해마다 몇 칸인지 — 폭이 좁은 해(예: 12월 한 칸만 있는 첫해)는 연도 글자를 빼서 옆 해와 겹치지 않게 한다.
  const yearCells = new Map();
  if (twoRow) for (const c of cats) yearCells.set(c.slice(0, 4), (yearCells.get(c.slice(0, 4)) || 0) + 1);
  cats.forEach((c, ci) => {
    const gx = padL + ci * groupW + 7;
    const p = twoRow ? splitPeriod(by, c, cats[ci - 1]) : null;
    if (p) {
      if (p.first && ci > 0) {
        // 해가 바뀌는 곳에 옅은 세로선
        svg += `<line class="yearsep" x1="${gx - 7}" x2="${gx - 7}" y1="8" y2="${H - 4}"/>`;
      }
      if ((p.n - 1) % subStep === 0) {
        svg += `<text class="tick" x="${gx + (groupW - 14) / 2}" y="${H - 26}" text-anchor="middle">${p.sub}</text>`;
      }
      if (p.first && yearCells.get(p.year) * groupW >= 40) {
        svg += `<text class="tick year" x="${gx - 4}" y="${H - 8}" text-anchor="start">${p.year}년</text>`;
      }
    }
    series.forEach((s, si) => {
      const v = s.values[ci];
      if (!v) return;
      const x = gx + si * (barW + 2);
      svg += `<path fill="var(--s${s.slot})" d="${barPath(x, y(v), barW, y(0) - y(v))}"
        data-tip="<b>${esc(fmtBucketLabel(by, c))}</b><br>${esc(esc(s.name))}: ${n(v)}원 (${won(v)}원)${tipParts(s.parts?.[ci])}"/>`;
    });
    if (!p && ci % step === 0) {
      svg += `<text class="tick" x="${gx + (groupW - 14) / 2}" y="${H - 8}" text-anchor="middle">${esc(fmtBucketLabel(by, c))}</text>`;
    }
  });
  svg += `<line class="axis" x1="${padL}" x2="${W}" y1="${y(0)}" y2="${y(0)}"/>`;
  el.innerHTML = `<svg width="${W}" height="${H}" role="img" aria-label="기간별 실적">${svg}</svg>`;
  bindVizTip(el);
}

/** 구간 × 업체 표 (차트의 표 보기, 수요기관 TOP) */
function perfTable(target, data, series, labelOf, labelHead) {
  const total = (ci) => series.reduce((s, x) => s + x.values[ci], 0);
  const multi = series.length > 1;
  const head = `<thead><tr><th>${esc(labelHead)}</th>${series
    .map((s) => `<th class="num">${multi ? swatch(s.slot) : ''}${esc(multi ? s.name : '금액')}</th>`)
    .join('')}${multi ? '<th class="num">합계</th>' : '<th class="num">납품요구</th>'}</tr></thead>`;
  if (!data.cats.length) return ($(target).innerHTML = '<tbody><tr><td class="empty">조건에 맞는 자료가 없습니다.</td></tr></tbody>');
  const body = data.cats
    .map(
      (c, ci) => `<tr><td>${esc(labelOf(c))}</td>${series.map((s) => `<td class="num nowrap">${s.values[ci] ? n(s.values[ci]) : '-'}</td>`).join('')}
        ${multi ? `<td class="num nowrap"><b>${n(total(ci))}</b></td>` : `<td class="num">${n(series[0].reqs[ci])}</td>`}</tr>`
    )
    .join('');
  $(target).innerHTML = head + `<tbody>${body}</tbody>`;
}

/** 서버 결과를 업체별 계열로 편다. 10곳보다 많으면 상위 7곳 + '그 외' 로 합친다 */
function toSeries(res) {
  const idx = new Map(res.buckets.map((b, i) => [b ?? '', i]));
  const series = perf.view.map((c) => {
    const values = res.buckets.map(() => 0);
    const reqs = res.buckets.map(() => 0);
    for (const r of res.rows) {
      if (r.bizno !== c.bizno) continue;
      const i = idx.get(r.bucket ?? '');
      if (i === undefined) continue;
      values[i] = r.amt;
      reqs[i] = r.reqs;
    }
    return { ...c, values, reqs };
  });
  return series.length <= PERF_CORPS_MAX ? series : foldOthers(series);
}

/** 계열을 상위 7개만 두고 나머지를 '그 외 N곳' 한 계열(8번째 색)로 합친다 */
function foldOthers(series) {
  const rest = series.slice(PERF_MAX - 1);
  const sum = (k) => rest[0][k].map((_, i) => rest.reduce((a, s) => a + s[k][i], 0));
  return [...series.slice(0, PERF_MAX - 1), { slot: PERF_MAX, name: `그 외 ${n(rest.length)}곳`, values: sum('values'), reqs: sum('reqs'), other: true }];
}

/**
 * 기간별 실적의 계열 — 품목 기준. 고른 업체들은 합쳐서 한 막대로 (툴팁에 업체별 금액).
 *   품목을 체크하지 않았으면 '전체 품목' 한 계열, 체크했으면 체크한 품목마다 한 계열.
 */
function toDtilSeries(res, dtils) {
  const idx = new Map(res.buckets.map((b, i) => [b ?? '', i]));
  const names = new Map(perf.view.map((c) => [c.bizno, c.name]));
  const groups = dtils.length ? dtils.map((d, i) => ({ key: d, name: d, slot: i + 1 })) : [{ key: null, name: '전체 품목', slot: 1 }];
  return groups.map((g) => {
    const values = res.buckets.map(() => 0);
    const reqs = res.buckets.map(() => 0);
    const parts = res.buckets.map(() => new Map());
    for (const r of res.rows) {
      if (g.key !== null && r.dtil !== g.key) continue;
      const i = idx.get(r.bucket ?? '');
      if (i === undefined) continue;
      values[i] += r.amt;
      reqs[i] += r.reqs;
      parts[i].set(r.bizno, (parts[i].get(r.bizno) || 0) + r.amt);
    }
    return {
      slot: g.slot,
      name: g.name,
      values,
      reqs,
      parts: parts.map((m) => [...m].map(([b, amt]) => ({ name: names.get(b) || b, amt }))),
    };
  });
}

/**
 * 기간별 실적 그리기 (perf.last). 업체는 언제나 업체 색으로 구분한다.
 *   품목 체크 없음        → 차트 하나, 업체마다 한 계열 (전체 품목 합계)
 *   품목 체크 + 업체 1곳  → 차트 하나, 품목마다 한 계열
 *   품목 체크 + 업체 여럿 → 품목마다 작은 차트, 그 안에서 업체마다 한 계열
 * withTable: 표도 다시 만든다 (창 크기만 바뀌었을 때는 차트만)
 */
function renderPeriod(withTable) {
  const { period, by, dtils } = perf.last;
  const chart = $('#pfPeriodChart');
  const more = $('#pfPeriodMore');
  const head = by === 'year' ? '연도' : by === 'quarter' ? '분기' : '월';
  const label = (b) => fmtBucketLabel(by, b);
  const multiples = dtils.length > 0 && perf.view.length > 1;

  if (!multiples) {
    const ps = dtils.length ? toDtilSeries(period, dtils) : toSeries(period);
    if (withTable) {
      vizLegend('#pfPeriodLegend', ps);
      perfTable('#pfPeriodTable', { cats: period.buckets }, ps, label, head);
      $('#pfPeriodTable').hidden = false;
      more.innerHTML = '';
    }
    chart.classList.remove('pf-multi');
    verticalBars(chart, period.buckets, ps, by);
    return;
  }

  // 품목별 작은 차트 — 세로축은 차트마다 따로 (품목 사이 금액 차이가 커서)
  const parts = dtils.map((d) => {
    const ps = toSeries({ buckets: period.buckets, rows: period.rows.filter((r) => r.dtil === d) });
    const sum = ps.reduce((s, x) => s + x.values.reduce((a, v) => a + v, 0), 0);
    return { d, ps, sum };
  });
  if (withTable) {
    vizLegend('#pfPeriodLegend', parts[0].ps);
    $('#pfPeriodLegend').insertAdjacentHTML('beforeend', '<span class="muted small">품목마다 차트를 나눴습니다 · 세로축은 차트마다 다릅니다</span>');
    $('#pfPeriodTable').innerHTML = '';
    $('#pfPeriodTable').hidden = true;
    more.innerHTML = parts.map((p, i) => `<h3 class="pf-mh">${esc(p.d)}</h3><table id="pfPT${i}"></table>`).join('');
    parts.forEach((p, i) => perfTable('#pfPT' + i, { cats: period.buckets }, p.ps, label, head));
  }
  chart.classList.add('pf-multi');
  chart.innerHTML = parts
    .map((p, i) => `<div class="pf-mc"><h3 class="pf-mh">${esc(p.d)} <span class="muted small">${won(p.sum)}원</span></h3><div class="viz" id="pfMC${i}"></div></div>`)
    .join('');
  parts.forEach((p, i) => verticalBars($('#pfMC' + i), period.buckets, p.ps, by));
}

/* ── 실적: 기간별 품목 체크 목록 ── */

/** 목록을 다시 그린다. names: 고른 업체들이 판 품목(금액 큰 순), amt: 품목별 합계 */
function renderDtilPick(names, amt) {
  const pop = $('#pfDtilPop');
  const full = perf.dtils.length >= PF_DTIL_MAX;
  pop.innerHTML =
    `<div class="dp-note">체크하지 않으면 업체별로 전체 품목 합계를, 체크하면 품목마다 따로 그립니다 — 업체가 여럿이면 품목마다 차트를 나눠 업체별로 (최대 ${PF_DTIL_MAX}개).</div>
    <div class="dp-list">${names
      .map((d) => {
        const on = perf.dtils.includes(d);
        const off = !on && full;
        return `<label class="${off ? 'off' : ''}"><input type="checkbox" value="${esc(d)}"${on ? ' checked' : ''}${off ? ' disabled' : ''} />
          <span title="${esc(d)}">${on ? swatch(perf.dtils.indexOf(d) + 1) : ''}${esc(d)}</span>
          <span class="muted small nowrap">${won(amt.get(d) || 0)}원</span></label>`;
      })
      .join('') || '<div class="dp-note">이 조건에 거래가 없습니다.</div>'}</div>
    <div class="yp-foot"><button class="btn small" type="button" data-act="clear">전체 품목으로</button>
      <button class="btn small" type="button" data-act="close">닫기</button></div>`;
  const k = perf.dtils.length;
  $('#pfDtilBtn').textContent =
    (k === 0 ? `전체 품목 (${n(names.length)}개)` : k === 1 ? perf.dtils[0] : `${perf.dtils[0]} 외 ${k - 1}개`) + ' ▾';
}

function initDtilPicker() {
  const pop = $('#pfDtilPop');
  let timer = null;
  const changed = () => {
    // 목록은 다음 집계에서 다시 그리지만, 체크 표시·색·8개 제한은 바로 보이게
    const names = $$('input[type=checkbox]', pop).map((cb) => cb.value);
    const amt = new Map(perf.dtilAmt || []);
    renderDtilPick(names, amt);
    clearTimeout(timer);
    timer = setTimeout(() => loadPerf(), 300);
  };
  pop.addEventListener('change', (e) => {
    const cb = e.target.closest('input[type=checkbox]');
    if (!cb) return;
    if (cb.checked) {
      if (perf.dtils.length < PF_DTIL_MAX && !perf.dtils.includes(cb.value)) perf.dtils.push(cb.value);
    } else perf.dtils = perf.dtils.filter((d) => d !== cb.value);
    changed();
  });
  pop.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'close') pop.hidden = true;
    if (act === 'clear' && perf.dtils.length) {
      perf.dtils = [];
      changed();
    }
  });
  $('#pfDtilBtn').addEventListener('click', () => (pop.hidden = !pop.hidden));
  document.addEventListener('mousedown', (e) => {
    if (!pop.hidden && !pop.parentElement.contains(e.target)) pop.hidden = true;
  });
}

/** 창 크기가 바뀌면 차트만 다시 그린다 (막대 굵기가 화면 너비를 따라간다) */
let perfResizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(perfResizeTimer);
  perfResizeTimer = setTimeout(() => {
    const g = state.orders.group;
    if (g && (g.by === 'month' || g.by === 'year') && !$('#tab-orders').hidden && !$('#oGroup').hidden) {
      verticalBars($('#oGroupChart'), g.rows.map((r) => r.bucket), [{ slot: 1, name: '금액', values: g.rows.map((r) => r.amt) }], g.by);
    }
    const l = perf.last;
    if (!l || $('#tab-mine').hidden) return;
    renderPeriod(false);
  }, 150);
});

/** 품목을 이만큼 넘게 판 업체는 나머지를 접어 둔다 */
const PF_ITEMS_SHOWN = 5;

/**
 * 업체 실적 첫 표 — 업체마다 소계 한 줄 + 품목별 줄, 맨 아래 전체 합계.
 * byBiz: 업체별 전체(/perf corps), itemRows: 업체 × 세부품명(/perf by=dtil rows), total: 고른 업체 전체 합계
 */
/** 업체 실적 첫 표의 업체 순서 — 색(slot)은 업체를 따라가므로 순서만 바뀐다 */
const PF_SORTS = {
  amt: (a, b) => (b.s.amt || 0) - (a.s.amt || 0),
  last: (a, b) => String(b.s.last || '').localeCompare(String(a.s.last || '')) || (b.s.amt || 0) - (a.s.amt || 0),
  // "(주)하이" 가 "주식회사 논슬립선경" 앞에 오지 않게 회사 형태는 빼고 줄 세운다
  name: (a, b) =>
    String(a.c.name || '').replace(/\((주|유|재|사)\)|주식회사|유한회사|㈜/g, '').trim()
      .localeCompare(String(b.c.name || '').replace(/\((주|유|재|사)\)|주식회사|유한회사|㈜/g, '').trim(), 'ko'),
  added: () => 0,
};

function initPerfSort() {
  try {
    const v = localStorage.getItem('perfSort');
    if (v && PF_SORTS[v]) $('#pfSort').value = v;
    perf.scope = localStorage.getItem('perfScope') === 'all' ? 'all' : 'cond';
  } catch {}
  $('#pfScope').value = perf.scope;
  // 품목 범위 — 업체는 조건으로 고른 그대로, 실적만 검색한 세부품명 / 그 업체들의 모든 세부품명
  $('#pfScope').addEventListener('change', () => {
    perf.scope = $('#pfScope').value === 'all' ? 'all' : 'cond';
    try {
      localStorage.setItem('perfScope', perf.scope);
    } catch {}
    loadPerf('auto');
  });
  $('#pfSort').addEventListener('change', () => {
    try {
      localStorage.setItem('perfSort', $('#pfSort').value);
    } catch {}
    if (perf.summary) renderPerfSummary(...perf.summary);
  });
}

function renderPerfSummary(byBiz, itemRows, total, listing, locs = {}, condDtils = null) {
  perf.summary = [byBiz, itemRows, total, listing, locs, condDtils];
  // 업체를 직접 추가했을 때만 '추가한 순서' 가 뜻이 있다 (조건만으로 고른 상위 업체는 원래 금액 순)
  const manual = perf.view === perf.corps;
  $('#pfSort option[value=added]').hidden = !manual;
  if (!manual && $('#pfSort').value === 'added') $('#pfSort').value = 'amt';
  $('#pfSortBox').hidden = perf.view.length < 2;
  $('#pfScopeBox').hidden = !perfCond().fDtil;
  $('#pfSortRow').hidden = $('#pfSortBox').hidden && $('#pfScopeBox').hidden;
  const order = PF_SORTS[$('#pfSort').value] || PF_SORTS.amt;
  const view = perf.view
    .map((c) => ({ c, s: byBiz.get(c.bizno) || {} }))
    .sort(order)
    .map((x) => x.c);
  // 쇼핑몰 등록품목 — 세부품명 조건 안에서. 그 세부품명을 받아 둔 적이 없으면 '등록 없음' 이 틀린 말이라 쓰지 않는다
  const listed = new Map((listing?.rows || []).map((r) => [r.bizno, r]));
  const listLine = (bizno) => {
    if (!listing?.known) return '';
    const r = listed.get(bizno);
    if (!r) return ' · <span class="muted">쇼핑몰 등록 없음</span>';
    const range = r.pmin === r.pmax ? `${n(r.pmin)}원` : `${n(r.pmin)} ~ ${n(r.pmax)}원`;
    return ` · <span class="pf-list" title="지금 쇼핑몰에 올라와 있는 품목(세부품명) 수 · 규격 수 · 계약단가 범위${perf.market ? ' (세부품명 조건 안에서)' : ''}">쇼핑몰 등록 ${n(r.dtils)}개 품목 · ${n(r.items)}개 규격 · ${range}</span>`;
  };
  const cells = (s, strong) => {
    const b = (v) => (strong ? `<b>${v}</b>` : v);
    return `<td class="num nowrap">${b(n(s.amt))}<div class="muted small">${won(s.amt)}원</div></td>
      <td class="num">${n(s.cnt)}</td><td class="num">${n(s.reqs)}</td><td class="num">${n(s.instts)}</td>
      <td class="num nowrap">${s.reqs ? won(Math.round(s.amt / s.reqs)) + '원' : '-'}</td>
      <td class="nowrap small">${s.last ? ymd(s.last) : '<span class="muted">이 기간 거래 없음</span>'}</td>`;
  };
  const head = `<thead><tr><th>업체</th><th>품목</th><th class="num">납품 금액</th><th class="num">거래 줄</th>
    <th class="num">납품요구</th><th class="num">거래 기관</th><th class="num">건당 평균</th><th>최근 거래</th></tr></thead>`;

  // 조건이 있으면 조건 전체 금액 대비 점유율도 보여준다
  const share = (amt) =>
    perf.market?.amt ? ` <span class="muted small">점유율 ${((amt / perf.market.amt) * 100).toFixed(1)}%</span>` : '';
  // 전체 품목으로 볼 때 — 검색한 세부품명 줄에 ★ 와 점유율을 달고 맨 위로 (업체 합계는 조건 밖 품목까지라 점유율을 달지 않는다)
  const hit = new Set(perf.scopeAll ? condDtils || [] : []);
  const itemName = (r) => (hit.has(r.bucket) ? `<span class="pf-star" title="검색한 세부품명">★</span> ${esc(r.bucket)}` : esc(r.bucket || '(없음)'));
  const hitShare = (r) => (hit.has(r.bucket) ? share(r.amt) : '');
  const totalShare = (amt) => (perf.scopeAll ? '' : share(amt));
  const bodies = view.map((c) => {
    const s = byBiz.get(c.bizno) || {};
    const items = itemRows.filter((r) => r.bizno === c.bizno).sort((a, b) => hit.has(b.bucket) - hit.has(a.bucket) || b.amt - a.amt);
    const loc = locs[c.bizno] || c.loc;
    // 품목이 하나뿐이면 소계가 그 품목 줄과 같으니, 소계 자리에 품목 이름을 쓰고 품목 줄은 없앤다
    const single = items.length === 1;
    let html = `<tr class="pf-sub"><td>${swatch(c.slot)}<b>${esc(c.name)}</b>${
      loc ? ` <span class="pf-loc small" title="업체소재지">${esc(loc)}</span>` : ''
    }<div class="muted small">${esc(c.bizno)}${listLine(c.bizno)}</div></td>
      <td>${single ? itemName(items[0]) + hitShare(items[0]) : `<b>소계</b> <span class="muted small">${n(items.length)}개 품목</span>`}${totalShare(s.amt || 0)}</td>${cells(s, true)}</tr>`;
    if (!single) items.forEach((r, i) => {
      const more = items.length > PF_ITEMS_SHOWN + 1 && i >= PF_ITEMS_SHOWN;
      const pct = s.amt ? ` <span class="muted small" title="이 업체 납품 금액 가운데 비중">${((r.amt / s.amt) * 100).toFixed(1)}%</span>` : '';
      html += `<tr class="pf-item${more ? ' pf-more' : ''}"><td></td><td>${itemName(r)}${pct}${hitShare(r)}</td>${cells(r, false)}</tr>`;
    });
    if (items.length > PF_ITEMS_SHOWN + 1) {
      const rest = items.slice(PF_ITEMS_SHOWN);
      const restAmt = rest.reduce((a, r) => a + r.amt, 0);
      html += `<tr class="pf-toggle"><td></td><td colspan="7">
        <span class="when-closed">▸ 그 외 ${n(rest.length)}개 품목 펼치기 (${won(restAmt)}원)</span>
        <span class="when-open">▴ 접기</span></td></tr>`;
    }
    return `<tbody data-biz="${esc(c.bizno)}">${html}</tbody>`;
  });

  const foot =
    perf.view.length > 1 && total
      ? `<tfoot><tr><td>전체 합계</td><td>업체 ${n(perf.view.length)}곳${totalShare(total.amt)}</td>${cells(total, true)}</tr></tfoot>`
      : '';
  const table = $('#pfSummary');
  const open = new Set($$('tbody.open', table).map((t) => t.dataset.biz));
  table.innerHTML = head + bodies.join('') + foot;
  $$('tbody', table).forEach((tb) => {
    if (open.has(tb.dataset.biz)) tb.classList.add('open');
    tb.querySelector('.pf-toggle')?.addEventListener('click', () => tb.classList.toggle('open'));
  });
}

/* ── 실적: 조달청에서 업체 가져오기 ── */

/**
 * 업체명으로 조달청에서 그 업체의 쇼핑몰 등록품목을 받아 저장한다.
 * 넣은 이름과 같은 업체(main)는 바로 비교 목록에 넣고, 그 업체가 등록한 세부품명의 거래내역은
 * loadPerf('auto') 가 고른 기간만큼 채운다 (ensurePerfCoverage).
 */
async function fetchCorpFromG2B() {
  const term = $('#pfSearch').value.trim();
  if (!term) {
    $('#pfSearch').focus();
    return notice('#pfFetchResult', 'warn', '가져올 <b>업체명</b>을 업체 추가 칸에 넣어 주세요.');
  }
  if (state.viewer) return askCorp(term);
  const btn = $('#pfFetch');
  btn.disabled = true;
  notice('#pfFetchResult', 'info', `조달청에서 <b>${esc(term)}</b> 의 쇼핑몰 등록품목을 받는 중입니다… (30초 안팎)`);
  const poll = setInterval(async () => {
    const s = await api('/corpfetch/status').catch(() => null);
    if (s) notice('#pfFetchResult', 'info', `조달청에서 <b>${esc(term)}</b> 받는 중 — ${esc(s.step)} · 호출 ${n(s.calls)}회`);
  }, 1500);
  try {
    const r = await api('/corpfetch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ term }),
    });
    perf.fetch = r;
    for (const c of r.corps) if (c.main) addPerfCorp(c);
    renderCorpFetch();
    loadPerf('auto');
    refreshMeta();
  } catch (err) {
    notice('#pfFetchResult', 'warn', esc(err.message));
  } finally {
    clearInterval(poll);
    btn.disabled = false;
  }
}

/** 검색 전용 — 조달청을 직접 부를 수 없으니 관리자 PC 에 업체 가져오기를 요청한다 */
async function askCorp(term) {
  const btn = $('#pfFetch');
  btn.disabled = true;
  try {
    const r = await api('/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataset: 'corp', corp: term }),
    });
    const after = '관리자 PC 가 받으면 몇 분 뒤 이 PC 에도 들어옵니다. 그때 업체 추가 칸에서 이름을 찾아 추가하면, 그 업체가 등록한 세부품명의 거래내역도 요청할 수 있습니다.';
    if (r.state === 'sent') return notice('#pfFetchResult', 'info', `<b>${esc(term)}</b> 가져오기를 관리자에게 요청했습니다. ${after}`);
    if (r.state === 'dup') return notice('#pfFetchResult', 'info', `<b>${esc(term)}</b> 은(는) 이미 요청했습니다. ${after}`);
    notice('#pfFetchResult', 'warn', `요청을 보내지 못했습니다${r.error ? ` — ${esc(r.error)}` : ''}. 관리자에게 <b>${esc(term)}</b> 이(가) 필요하다고 알려 주세요.`);
  } catch (err) {
    notice('#pfFetchResult', 'warn', esc(err.message));
  } finally {
    btn.disabled = false;
  }
}

function renderCorpFetch() {
  const r = perf.fetch;
  if (!r) return;
  const when = r.cached ? `${esc(r.fetchedAt.slice(0, 10))} 에 받은 결과 (30일 안에는 다시 부르지 않습니다)` : `조달청 호출 ${n(r.calls)}회`;
  if (!r.corps.length) {
    return notice('#pfFetchResult', 'warn', `조달청에 <b>${esc(r.term)}</b> 이름으로 올라온 쇼핑몰 품목(MAS·제3자단가·일반단가, 최근 3년 등록분)이 없습니다. <span class="muted small">${when}</span>`);
  }
  const rows = r.corps
    .map((c) => {
      const inList = perf.corps.some((x) => x.bizno === c.bizno);
      return `<tr>
        <td><b>${esc(c.name)}</b><div class="muted small">${esc(c.bizno)}</div></td>
        <td><b>${n(c.dtils.length)}개 품목</b> · ${n(c.specs)}개 규격${c.added ? ` <span class="muted small">(새로 ${n(c.added)}개)</span>` : ''}
          <div class="small">${c.dtils.map((d) => `${esc(d.name)} <span class="muted">${n(d.specs)}</span>`).join(' · ')}</div></td>
        <td class="nowrap">${inList ? '<span class="muted small">비교 목록에 있음</span>' : `<button class="btn small" data-add="${esc(c.bizno)}">비교에 추가</button>`}</td>
      </tr>`;
    })
    .join('');
  $('#pfFetchResult').innerHTML = `<div class="notice info pf-fetch">
    <div><b>"${esc(r.term)}"</b> 조달청 조회 결과 <span class="muted small">· ${when}</span>
      ${r.corps.length > 1 ? '<span class="muted small">· 이름이 비슷한 업체가 여럿이면 넣은 이름과 같은 업체만 바로 추가합니다</span>' : ''}
      <button class="btn small" data-close style="float:right">닫기</button></div>
    <div class="tablewrap" style="margin-top:6px"><table>
      <thead><tr><th>업체</th><th>쇼핑몰 등록 품목 (품목별 규격 수)</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table></div></div>`;
  $$('#pfFetchResult [data-add]').forEach((b) =>
    b.addEventListener('click', () => {
      const c = r.corps.find((x) => x.bizno === b.dataset.add);
      if (c && addPerfCorp(c)) loadPerf('auto').then(renderCorpFetch);
    })
  );
  $('#pfFetchResult [data-close]').addEventListener('click', () => ($('#pfFetchResult').innerHTML = ''));
}

/* ── 실적: 연도 선택 (체크한 해만 집계, 떨어진 해도 가능) ── */

function loadPerfYears() {
  try {
    perf.years = new Set(JSON.parse(localStorage.getItem('perfYears') || '[]'));
  } catch {
    perf.years = new Set();
  }
}

function savePerfYears() {
  try {
    localStorage.setItem('perfYears', JSON.stringify([...perf.years]));
  } catch {}
}

function renderYearBtn() {
  const ys = [...perf.years].sort();
  $('#pfYearBtn').textContent = ys.length ? (ys.length <= 3 ? ys.join(', ') : `${ys.length}개 해`) + ' ▾' : '연도 선택 ▾';
}

/** 고른 해에 맞춰 시작일·종료일을 채운다 (첫 해 1월 1일 ~ 마지막 해 12월 31일, 어제를 넘지 않게) */
function applyYearsToDates() {
  const ys = [...perf.years].sort();
  if (!ys.length) return;
  const yesterday = daysAgo(1);
  $('#mFrom').value = `${ys[0]}-01-01`;
  const end = `${ys.at(-1)}-12-31`;
  $('#mTo').value = end > yesterday ? yesterday : end;
}

async function initYearPicker() {
  loadPerfYears();
  applyYearsToDates(); // 첫 집계가 목록을 받기 전에 돌아도 날짜가 고른 해와 맞게
  let years = [];
  try {
    years = await api('/perf/years');
  } catch {}
  // 데이터가 없는 해는 목록에서 빠지므로 고른 값도 정리한다
  for (const y of [...perf.years]) if (!years.includes(y)) perf.years.delete(y);
  const pop = $('#pfYearPop');
  pop.innerHTML =
    `<div class="yp-grid">${years
      .map((y) => `<label><input type="checkbox" value="${y}"${perf.years.has(y) ? ' checked' : ''} /> ${y}년</label>`)
      .join('')}</div>
    <div class="yp-foot"><button class="btn small" type="button" data-act="clear">모두 해제</button>
      <button class="btn small" type="button" data-act="close">닫기</button></div>`;
  let timer = null;
  const changed = () => {
    savePerfYears();
    renderYearBtn();
    applyYearsToDates();
    clearTimeout(timer);
    timer = setTimeout(() => loadPerf('auto'), 250);
  };
  $$('input[type=checkbox]', pop).forEach((cb) =>
    cb.addEventListener('change', () => {
      cb.checked ? perf.years.add(cb.value) : perf.years.delete(cb.value);
      changed();
    })
  );
  pop.querySelector('[data-act=clear]').addEventListener('click', () => {
    perf.years.clear();
    $$('input[type=checkbox]', pop).forEach((cb) => (cb.checked = false));
    changed();
  });
  pop.querySelector('[data-act=close]').addEventListener('click', () => (pop.hidden = true));
  $('#pfYearBtn').addEventListener('click', () => (pop.hidden = !pop.hidden));
  document.addEventListener('mousedown', (e) => {
    if (!pop.hidden && !pop.parentElement.contains(e.target)) pop.hidden = true;
  });
  // 날짜를 직접 고치면 연도 선택은 푼다 (둘이 어긋나지 않게)
  ['#mFrom', '#mTo'].forEach((id) =>
    $(id).addEventListener('change', () => {
      if (!perf.years.size) return;
      perf.years.clear();
      $$('input[type=checkbox]', pop).forEach((cb) => (cb.checked = false));
      savePerfYears();
      renderYearBtn();
    })
  );
  renderYearBtn();
  applyYearsToDates();
}

/* ── 실적: 검색 조건 (세부품명·업체소재지·기관지역) ── */

const PF_COND_INPUTS = { fDtil: '#pfCondDtil', corpLoc: '#pfCondLoc', rgn: '#pfCondRgn' };

function perfCond() {
  const c = {};
  for (const [k, id] of Object.entries(PF_COND_INPUTS)) c[k] = $(id).value.trim();
  return c;
}

function initPerfCond() {
  try {
    const saved = JSON.parse(localStorage.getItem('perfCond') || '{}');
    for (const [k, id] of Object.entries(PF_COND_INPUTS)) $(id).value = saved[k] || '';
    if (saved.topN && $(`#pfTopN option[value="${saved.topN}"]`)) $('#pfTopN').value = saved.topN;
  } catch {}
  const save = () => {
    try {
      localStorage.setItem('perfCond', JSON.stringify({ ...perfCond(), topN: $('#pfTopN').value }));
    } catch {}
  };
  attachItemSuggest($('#pfCondDtil'), () => 'dtil');
  attachOrderSuggest($('#pfCondLoc'), 'corpLoc', () => $('#pfCondDtil').value.trim());
  attachOrderSuggest($('#pfCondRgn'), 'rgn', () => $('#pfCondDtil').value.trim());
  // 자동완성에서 고르거나 칸을 벗어나면 change, Enter 로도 바로 집계
  Object.values(PF_COND_INPUTS).forEach((id) => {
    $(id).addEventListener('change', () => (save(), loadPerf()));
    $(id).addEventListener('keydown', (e) => e.key === 'Enter' && (save(), loadPerf()));
  });
  $('#pfTopN').addEventListener('change', () => (save(), loadPerf()));
  $('#pfCondClear').addEventListener('click', () => {
    Object.values(PF_COND_INPUTS).forEach((id) => ($(id).value = ''));
    save();
    loadPerf();
  });
}

/**
 * fillMode — 추가한 업체의 등록 세부품명 거래내역을 고른 기간만큼 채울지 (ensurePerfCoverage)
 *   'auto' : 업체를 새로 넣거나 기간을 바꿨을 때 — 설정·한도 안이면 바로 받는다
 *   'ask'  : 그 밖의 다시 그리기 — 빠진 게 있으면 알리고 버튼으로 묻는다
 *   null   : 확인하지 않는다 (채운 뒤 다시 그릴 때)
 */
async function loadPerf(fillMode = 'ask') {
  const cond = perfCond();
  const hasCond = Object.values(cond).some(Boolean);
  const period0 = { from: dateVal('#mFrom'), to: dateVal('#mTo'), years: [...perf.years].join(','), ...cond };

  // 비교할 업체: 추가한 업체가 있으면 그 업체들, 없고 조건만 있으면 조건에 맞는 상위 업체.
  perf.market = null;
  perf.scopeAll = perf.scope === 'all' && Boolean(cond.fDtil);
  if (hasCond) {
    const top = await api('/perf/top?' + qs({ ...period0, limit: perf.corps.length ? 1 : $('#pfTopN').value }));
    perf.market = top.market;
    // 색은 8개 — 9곳 이상이면 상위 7곳만 제 색, 나머지는 8번째 색('그 외')을 같이 쓴다
    const many = top.rows.length > PERF_CORPS_MAX;
    perf.view = perf.corps.length
      ? perf.corps
      : top.rows.map((r, i) => ({ bizno: r.bizno, name: r.name, loc: r.loc, slot: many ? Math.min(i + 1, PERF_MAX) : i + 1, auto: true }));
  } else {
    compactPerfSlots();
    perf.view = perf.corps;
  }
  renderPerfChips();

  const empty = !perf.view.length;
  ['#pfSummary', '#pfPeriodTable', '#pfPeriodMore', '#pfInstt', '#pfPeriodLegend'].forEach((id) => empty && ($(id).innerHTML = ''));
  ['#pfPeriodChart'].forEach(
    (id) =>
      empty &&
      ($(id).innerHTML = `<div class="empty">${hasCond ? '조건에 맞는 거래가 없습니다.' : '업체를 추가하거나 세부품명·지역 조건을 넣으면 실적이 나옵니다.'}</div>`)
  );
  notice('#mineNotice', '', '');
  if (fillMode) ensurePerfCoverage(fillMode);
  if (empty) return;

  // 조건만으로 고른 상위 업체는 서버가 같은 순서로 다시 고른다 (전체면 수백 곳이라 주소에 다 싣지 않는다)
  const auto = perf.view.some((c) => c.auto);
  const scope = perf.scopeAll ? { scope: 'all' } : {};
  const base = auto ? { ...period0, ...scope, top: $('#pfTopN').value } : { ...period0, ...scope, biznos: perf.view.map((c) => c.bizno).join(',') };
  const by = $('#pfPeriod').value;
  const fetchPicked = () => {
    const picked = perf.dtils.length ? { dtils: JSON.stringify(perf.dtils) } : {};
    return Promise.all([
      api('/perf?' + qs({ ...base, by, ...picked, split: perf.dtils.length ? 'dtil' : '' })),
      api('/perf?' + qs({ ...base, by: 'instt', limit: $('#pfInsttN').value, ...picked })),
    ]);
  };
  let [[period, instt], dtil] = await Promise.all([fetchPicked(), api('/perf?' + qs({ ...base, by: 'dtil', limit: 0, listing: 1 }))]);

  // 품목 체크 목록: 고른 업체들이 판 세부품명을 합계 금액 큰 순으로. 체크한 품목이 목록에서 빠지면 체크를 푼다.
  const dtilAmt = new Map();
  for (const r of dtil.rows) dtilAmt.set(r.bucket ?? '', (dtilAmt.get(r.bucket ?? '') || 0) + r.amt);
  perf.dtilAmt = [...dtilAmt];
  const names = dtil.buckets.filter((b) => b);
  const kept = perf.dtils.filter((d) => names.includes(d));
  if (kept.length !== perf.dtils.length) {
    perf.dtils = kept;
    [period, instt] = await fetchPicked();
  }
  renderDtilPick(names, dtilAmt);

  // 업체별 요약 — 품목과 관계없이 전체 (이름은 가장 최근 거래의 이름으로 맞춘다)
  const byBiz = new Map(period.corps.map((c) => [c.bizno, c]));
  for (const c of perf.view) if (byBiz.get(c.bizno)?.name) c.name = byBiz.get(c.bizno).name;
  if (perf.view === perf.corps) savePerfCorps();
  renderPerfChips();
  renderPerfSummary(byBiz, dtil.rows, period.total, dtil.listing, dtil.locs, dtil.condDtils);

  perf.last = { period, by, dtils: [...perf.dtils] };
  renderPeriod(true);

  perfTable('#pfInstt', { cats: instt.buckets }, toSeries(instt), (b) => b || '(없음)', '수요기관');
  const k = perf.dtils.length;
  $('#pfInsttDtil').textContent = k === 0 ? '· 전체 품목' : k === 1 ? `· ${perf.dtils[0]}` : `· 체크한 품목 ${k}개`;
  $('#pfInsttDtil').title = perf.dtils.join(', ') || '기간별 실적의 품목 선택을 따라갑니다';
}


/* ── 관심목록 ─────────────────────────────────────────────────── */

/**
 * ★ 칸 — 이미 관심목록에 담은 물품은 색이 채워져 보이고, 다시 누르면 관심목록에서 뺀다.
 * 검색할 때마다 관심목록을 한 번 읽어 표시를 맞춘다 (다시 검색해도 담김이 보이게).
 */
async function bindMarks(scope) {
  const btns = $$('button[data-mark]', $(scope));
  if (!btns.length) return;
  let marks = [];
  try {
    marks = await api('/bookmarks');
  } catch {}
  const idOf = new Map(marks.map((m) => [m.kind + '|' + m.ref_key, m.id]));
  const keyOf = (b) => b.dataset.mark + '|' + b.dataset.key;
  const paint = (b) => {
    const on = idOf.has(keyOf(b));
    b.classList.toggle('marked', on);
    b.title = on ? '관심목록에 담겨 있습니다 — 누르면 뺍니다' : '관심목록에 담기';
  };
  btns.forEach((b) => {
    paint(b);
    b.addEventListener('click', async () => {
      const k = keyOf(b);
      b.disabled = true;
      try {
        if (idOf.has(k)) {
          await api('/bookmarks/' + idOf.get(k), { method: 'DELETE' });
          idOf.delete(k);
        } else {
          const list = await api('/bookmarks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ kind: b.dataset.mark, refKey: b.dataset.key, title: b.dataset.title, subtitle: b.dataset.sub }),
          });
          const m = list.find((x) => x.kind + '|' + x.ref_key === k);
          if (m) idOf.set(k, m.id);
        }
      } catch (err) {
        alert(err.message);
      } finally {
        b.disabled = false;
        paint(b);
      }
    });
  });
}

/**
 * 추가한 업체들이 쇼핑몰에 등록한 세부품명(저장된 등록품목, 고른 기간에 계약이 걸친 것)의 거래내역 가운데
 * 고른 기간에 아직 안 받은 날짜를 채운다. 'auto' 면 설정의 자동 받기가 켜져 있을 때 오늘 남은 한도 안에서
 * 바로 받는다 — 거래내역 탭과 달리 최대 일수는 보지 않는다 (업체를 넣으면 그 실적이 바로 보여야 하므로).
 * 한도를 넘거나 'ask' 면 버튼으로 묻는다.
 * 세부품명으로 좁혀 받으므로 그 품목의 다른 업체 거래도 같이 저장된다 (경쟁 비교에도 쓰임).
 */
async function ensurePerfCoverage(mode, lead = '') {
  if (perf.filling) return;
  // 채울 업체: 추가한 업체. 없으면 '전체 품목' 으로 볼 때 조건으로 고른 업체 (금액 큰 순으로 PERF_CORPS_MAX 곳까지)
  const picked = perf.corps.length ? perf.corps : perf.scopeAll ? perf.view.slice(0, PERF_CORPS_MAX) : [];
  if (!picked.length) return fillBanner('', '');
  const who = perf.corps.length ? '추가한 업체' : perf.view.length > picked.length ? `상위 ${n(picked.length)}곳` : '보이는 업체';
  const whoGa = who + (who.endsWith('곳') ? '이' : '가');
  // 조건으로 고른 업체는 여러 곳이라 저절로 받지 않고 예상 호출 수를 보여 준 뒤 묻는다
  if (!perf.corps.length && mode === 'auto') mode = 'ask';
  const banner = (kind, html) => fillBanner(kind, (lead ? lead + '<br>' : '') + html);
  const from = dateVal('#mFrom').replace(/-/g, '');
  const to = dateVal('#mTo').replace(/-/g, '');
  if (from.length !== 8 || to.length !== 8) return;
  let plan;
  try {
    plan = await api(
      '/perf/fillplan?' +
        qs({
          biznos: picked.map((c) => c.bizno).join(','),
          corps: perf.scopeAll ? JSON.stringify(picked.map(({ bizno, name }) => ({ bizno, name }))) : '',
          from,
          to,
          years: [...perf.years].join(','),
        })
    );
  } catch {
    return; // 확인이 실패해도 실적은 이미 나와 있다
  }
  if (perf.filling) return;
  const names = (xs) => xs.slice(0, 6).map(esc).join(' · ') + (xs.length > 6 ? ` 외 ${n(xs.length - 6)}개` : '');

  // 전체 품목 — 업체 단위로 등록품목을 받아 본 적 없는 업체는, 등록했지만 거래내역을 안 받은 세부품명이 더 있을 수 있다
  const unknown = plan.unknown || [];
  const skipKey = unknown.map((c) => c.bizno).join(',');
  if (perf.scopeAll && unknown.length && perf.skipUnknown !== skipKey) return askCorpListings(unknown, who, names, mode, skipKey);

  if (!plan.dtils.length) {
    return banner(
      '',
      `<span class="small">${who}의 저장된 등록품목이 이 기간에 없어 거래내역을 채울 세부품명이 없습니다.` +
        ` 업체 추가 칸에 이름을 넣고 <b>조달청에서 가져오기</b>로 등록품목을 받으면 그 세부품명의 거래내역을 채웁니다.</span>`
    );
  }
  const jobs = plan.jobs;
  const all = plan.dtils.map((d) => d.dtil);
  if (!jobs.length) {
    return banner('', `<span class="small">${whoGa} 등록한 세부품명 ${n(all.length)}개(${names(all)})의 거래내역을 이 기간 모두 받아 두었습니다 · API 호출 0회</span>`);
  }
  const todo = [...new Set(jobs.map((j) => j.dtil))];
  const days = new Map();
  for (const j of jobs) days.set(j.dtil, (days.get(j.dtil) || 0) + j.missingDays);
  const detail = todo.map((d) => `${esc(d)} ${n(days.get(d))}일`).join(' · ');
  const est = jobs.reduce((t, j) => t + (j.estCalls || 0), 0);
  const estText = state.mobile ? '' : plan.mock ? '샘플 모드라 API 호출 없음' : `예상 API 약 ${n(est)}회 · 오늘 남은 ${n(plan.remainingCalls)}회`;
  const what =
    `${whoGa} 등록한 세부품명 <b>${n(todo.length)}개</b>의 거래내역 가운데 이 기간에 아직 받지 않은 날짜가 있습니다${estText ? ` <span class="small muted">(${estText})</span>` : ''}` +
    `<br><span class="small">${detail}</span>`;

  if (state.viewer) {
    banner(
      'warn',
      `${what}<br><span class="small">검색 전용 프로그램이라 직접 받을 수 없습니다. 관리자 PC 에 요청하면 대신 받아서 몇 분 뒤 여기에도 들어옵니다.</span>` +
        ` <button class="btn primary" id="pfReqSend">관리자에게 요청 보내기 (세부품명 ${n(todo.length)}개)</button>`
    );
    $('#pfReqSend').addEventListener('click', async () => {
      const b = $('#pfReqSend');
      b.disabled = true;
      b.textContent = '보내는 중…';
      const got = { sent: 0, dup: 0, fail: 0 };
      let why = '';
      for (const j of jobs) {
        try {
          const r = await api('/ask', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dataset: 'dlvrDtl', from: j.from, to: j.to, dtil: j.dtil }),
          });
          if (r.state === 'sent' || r.state === 'dup') got[r.state]++;
          else (got.fail++, (why = r.error || why));
        } catch (err) {
          got.fail++;
          why = err.message;
        }
      }
      fillBanner(
        got.fail ? 'warn' : '',
        got.fail
          ? `요청 ${n(got.sent + got.dup)}건은 보냈지만 ${n(got.fail)}건은 보내지 못했습니다${why ? ` — <span class="small">${esc(why)}</span>` : ''}` +
              `<br><span class="small">관리자에게 <b>${todo.map(esc).join(', ')}</b> 거래내역이 필요하다고 알려 주세요.</span>`
          : `요청을 보냈습니다${got.dup ? ` (이미 요청한 ${n(got.dup)}건 포함)` : ''}. 관리자 PC 가 받으면 몇 분 뒤 이 화면에도 들어옵니다.`
      );
    });
    return;
  }

  if (plan.collecting) {
    return banner('warn', `${what}<br><span class="small">다른 수집이 진행 중입니다. 끝난 뒤 <b>집계</b>를 누르면 채웁니다.</span>`);
  }
  const s = state.settings;
  const overQuota = !plan.mock && est > plan.remainingCalls;

  const doFill = async () => {
    perf.filling = true;
    const sum = { fetched: 0, calls: 0, days: 0 };
    let failed = null;
    try {
      for (const [i, j] of jobs.entries()) {
        const head = `세부품명 ${i + 1}/${jobs.length} · <b>${esc(j.dtil)}</b> ${ymd(j.from)} ~ ${ymd(j.to)}`;
        fillBanner('', `${head} 받는 중…`);
        await api('/collect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            datasetId: 'dlvrDtl',
            bgnDate: j.from,
            endDate: j.to,
            onlyMissing: true,
            filters: j.filters,
            numOfRows: 999,
            maxPages: 200,
            chunkDays: j.chunkDays,
          }),
        });
        const job = await waitCollect((x) => {
          if (x?.running) fillBanner('', `${head} — ${x.chunkDone}/${x.chunkTotal} 구간 · ${n(x.fetched)}건 · API ${n(sum.calls + x.calls)}회`);
        });
        sum.fetched += job?.fetched || 0;
        sum.calls += job?.calls || 0;
        sum.days += job?.targetDays || 0;
        if (job?.error) {
          failed = `${esc(j.dtil)}: ${esc(job.error.message)}${job.error.hint ? ' — ' + esc(job.error.hint) : ''}`;
          break;
        }
      }
    } catch (err) {
      failed = esc(err.message);
    } finally {
      perf.filling = false;
    }
    // 다시 그린 뒤 결과를 띄운다
    await loadPerf(null);
    refreshMeta();
    const done = `세부품명 거래내역 ${n(sum.fetched)}건을 받아 채웠습니다 (API ${n(sum.calls)}회)`;
    fillBanner(
      failed ? 'err' : '',
      failed ? `${done}. 받는 도중 멈췄습니다 — ${failed}<br><span class="small">받은 만큼은 저장됐고, 다시 <b>집계</b>를 누르면 나머지만 이어 받습니다.</span>` : done
    );
  };

  if (mode === 'auto' && s.autoFill && !overQuota) return doFill();
  const why = mode !== 'auto' ? '' : !s.autoFill ? '자동 받기가 꺼져 있습니다.' : '예상 호출 수가 오늘 남은 한도보다 많습니다.';
  banner('warn', `${what}<br><span class="small">${why}</span> <button class="btn primary" id="pfFillGo">빠진 날짜만 받기 (약 ${n(est)}회)</button>`);
  $('#pfFillGo').addEventListener('click', doFill);
}

/**
 * 전체 품목 — 등록품목을 업체 단위로 받아 본 적 없는 업체를 알리고, 조달청에서 업체명으로 받는다 (업체당 API 10~20회).
 * 받은 뒤 ensurePerfCoverage 가 그 업체들이 등록한 세부품명 가운데 거래내역이 빠진 날짜를 보여 주고 묻는다.
 * 검색 전용·모바일은 관리자 PC 에 업체 가져오기를 요청한다 (관리자 PC 가 등록품목과 올해 거래내역을 받는다).
 */
function askCorpListings(unknown, who, names, mode, skipKey) {
  const list = names(unknown.map((c) => c.name));
  const what =
    `${who} 가운데 <b>${n(unknown.length)}곳</b>은 조달청에서 등록품목을 아직 받지 않아, 등록했지만 거래내역을 받지 않은 세부품명이 더 있을 수 있습니다.` +
    `<br><span class="small">${list}</span>`;
  const skip = '<button class="btn" id="pfCorpSkip">건너뛰고 받아 둔 것만 보기</button>';
  if (state.viewer) {
    fillBanner('warn', `${what}<br><button class="btn primary" id="pfCorpAsk">관리자에게 등록품목 요청 (${n(unknown.length)}곳)</button> ${skip}`);
  } else {
    fillBanner(
      'warn',
      `${what}<br><button class="btn primary" id="pfCorpGo">등록품목 받기 (${n(unknown.length)}곳 · 약 ${n(unknown.length * 10)}~${n(unknown.length * 20)}회)</button> ${skip}`
    );
  }
  $('#pfCorpSkip').addEventListener('click', () => {
    perf.skipUnknown = skipKey;
    ensurePerfCoverage(mode);
  });

  $('#pfCorpAsk')?.addEventListener('click', async () => {
    const b = $('#pfCorpAsk');
    b.disabled = true;
    b.textContent = '보내는 중…';
    const got = { sent: 0, dup: 0, fail: 0 };
    let why = '';
    for (const c of unknown) {
      try {
        const r = await api('/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dataset: 'corp', corp: c.name }) });
        if (r.state === 'sent' || r.state === 'dup' || r.state === 'queued') got[r.state === 'dup' ? 'dup' : 'sent']++;
        else (got.fail++, (why = r.error || why));
      } catch (err) {
        got.fail++;
        why = err.message;
      }
    }
    perf.skipUnknown = skipKey; // 받아 올 때까지는 받아 둔 것으로 본다
    const note = got.fail
      ? `요청 ${n(got.sent + got.dup)}곳은 보냈지만 ${n(got.fail)}곳은 보내지 못했습니다${why ? ` — ${esc(why)}` : ''}.`
      : `등록품목 요청을 보냈습니다${got.dup ? ` (이미 요청한 ${n(got.dup)}곳 포함)` : ''}. 관리자 PC 가 받으면 몇 분 뒤 이 화면에도 들어옵니다.`;
    ensurePerfCoverage(mode, `<span class="small">${note}</span>`);
  });

  $('#pfCorpGo')?.addEventListener('click', async () => {
    perf.filling = true;
    let calls = 0;
    const fails = [];
    try {
      for (const [i, c] of unknown.entries()) {
        fillBanner('', `조달청에서 등록품목 받는 중 ${i + 1}/${unknown.length} · <b>${esc(c.name)}</b>… (업체마다 30초 안팎)`);
        try {
          const r = await api('/corpfetch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ term: c.name }) });
          if (!r.cached) calls += r.calls || 0;
        } catch (err) {
          fails.push(`${esc(c.name)}: ${esc(err.message)}`);
        }
      }
    } finally {
      perf.filling = false;
    }
    perf.skipUnknown = skipKey; // 이름으로 못 찾은 업체를 다시 묻지 않게
    refreshMeta();
    await loadPerf(null);
    const note =
      `등록품목을 받았습니다 (${n(unknown.length - fails.length)}곳 · API ${n(calls)}회)` +
      (fails.length ? ` · 못 받은 업체 ${n(fails.length)}곳 — ${fails.slice(0, 3).join(' / ')}` : '');
    ensurePerfCoverage('ask', `<span class="small">${note}</span>`);
  });
}

/* ── 관심목록 (세부품명 칩 + 묶음 표, 체크해서 물품비교로) ─────────── */

/** dtil: 지금 보는 칩('' = 전체), items: 담은 물품 전부, raw: 메모 저장용 원래 줄 */
const marks = { dtil: '', items: [], raw: new Map(), note: '' };

let marksBound = false;
function bindMarkTools() {
  if (marksBound) return;
  marksBound = true;
  try {
    marks.dtil = localStorage.getItem('marksDtil') || '';
    const sort = localStorage.getItem('marksSort');
    if (sort && $(`#mSort option[value="${sort}"]`)) $('#mSort').value = sort;
  } catch {}
  $('#mFind').addEventListener('input', renderMarks);
  $('#mSort').addEventListener('change', () => {
    try {
      localStorage.setItem('marksSort', $('#mSort').value);
    } catch {}
    renderMarks();
  });
  $('#mAll').addEventListener('click', () => {
    const room = Math.max(0, CMP_MAX - cmp.picked.length);
    const add = marksVisible()
      .flatMap(([, xs]) => xs)
      .filter((x) => !x.missing && !cmp.picked.includes(x.id))
      .map((x) => x.id);
    cmp.picked.push(...add.slice(0, room));
    if (add.length > room) marks.note = `최대 ${CMP_MAX}개까지 비교할 수 있어 앞의 ${room}개만 체크했습니다.`;
    saveCmpPicked();
    renderMarks();
  });
  $('#mNone').addEventListener('click', () => {
    cmp.picked = [];
    saveCmpPicked();
    renderMarks();
  });
  $('#mGo').addEventListener('click', () => showTab('compare'));
  $('#bChips').addEventListener('click', (e) => {
    const c = e.target.closest('[data-dtil]');
    if (!c) return;
    marks.dtil = c.dataset.dtil;
    $('#mFind').value = '';
    try {
      localStorage.setItem('marksDtil', marks.dtil);
    } catch {}
    renderMarks();
  });
  $('#bTable').addEventListener('change', async (e) => {
    const cb = e.target.closest('input[data-pick]');
    if (cb) {
      const id = Number(cb.value);
      cmp.picked = cb.checked ? [...cmp.picked, id].slice(0, CMP_MAX) : cmp.picked.filter((x) => x !== id);
      saveCmpPicked();
      renderMarks();
      return;
    }
    const i = e.target.closest('input[data-memo]');
    const r = i && marks.raw.get(Number(i.dataset.memo));
    if (!r) return;
    await api('/bookmarks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: r.kind, refKey: r.ref_key, title: r.title, subtitle: r.subtitle, memo: i.value }),
    });
    const x = marks.items.find((x) => x.id === r.id);
    if (x) x.memo = i.value;
  });
  $('#bTable').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-del]');
    if (!b) return;
    const id = Number(b.dataset.del);
    await api('/bookmarks/' + id, { method: 'DELETE' });
    cmp.picked = cmp.picked.filter((x) => x !== id);
    saveCmpPicked();
    loadBookmarks();
  });
}

async function loadBookmarks() {
  bindMarkTools();
  loadCmpPicked();
  const [raw, items] = await Promise.all([api('/bookmarks'), api('/compare/pick')]);
  marks.raw = new Map(raw.map((r) => [r.id, r]));
  marks.items = items;
  // 관심목록에서 지운 물품은 체크에서도 뺀다
  const have = new Set(items.filter((x) => !x.missing).map((x) => x.id));
  cmp.picked = cmp.picked.filter((id) => have.has(id));
  saveCmpPicked();
  $('#mTools').hidden = !items.length;
  renderMarks();
}

/** [세부품명, 물품들] — 많이 담은 품목부터 */
function markGroups(xs) {
  const m = new Map();
  for (const x of xs) {
    const g = cmpGroup(x);
    if (!m.has(g)) m.set(g, []);
    m.get(g).push(x);
  }
  return [...m].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0], 'ko'));
}

/** 지금 칩·찾기·정렬로 보이는 [세부품명, 물품들] */
function marksVisible() {
  const t = $('#mFind').value.trim().toLowerCase();
  const xs = marks.items.filter(
    (x) =>
      (!marks.dtil || cmpGroup(x) === marks.dtil) &&
      (!t || [x.corp_nm, x.spec_nm, x.prdct_idnt_no, x.corp_loc, x.title, x.memo].join(' ').toLowerCase().includes(t))
  );
  const by = $('#mSort').value;
  const price = (x) => (x.price > 0 ? x.price : Infinity);
  // "(주)하이" 가 "주식회사 논슬립선경" 앞에 오지 않게 회사 형태는 빼고 줄 세운다
  const corp = (x) => String(x.corp_nm || '').replace(/\((주|유|재|사)\)|주식회사|유한회사|㈜/g, '').trim();
  const order =
    by === 'price'
      ? (a, b) => price(a) - price(b)
      : by === 'recent'
        ? (a, b) => b.id - a.id
        : (a, b) => corp(a).localeCompare(corp(b), 'ko') || price(a) - price(b);
  return markGroups(xs).map(([g, ys]) => [g, ys.sort(order)]);
}

function renderMarks() {
  const groups = markGroups(marks.items);
  if (marks.dtil && !groups.some(([g]) => g === marks.dtil)) marks.dtil = '';
  const k = cmp.picked.length;
  $('#bChips').innerHTML = marks.items.length
    ? [['', marks.items], ...groups]
        .map(([g, xs]) => {
          const on = xs.filter((x) => cmp.picked.includes(x.id)).length;
          return `<button type="button" class="chip${g === marks.dtil ? ' on' : ''}" data-dtil="${esc(g)}">${g ? esc(g) : '전체'} <b>${n(xs.length)}</b>${
            on && g ? ` <span class="cmp-k-n">${n(on)}개 선택</span>` : ''
          }</button>`;
        })
        .join('')
    : '';
  $('#mCount').textContent = `선택 ${n(k)} / ${CMP_MAX}`;
  $('#mGo').disabled = !k;
  $('#mGo').textContent = k ? `비교하기 (${n(k)}개) →` : '비교하기';
  $('#mNote').innerHTML = marks.note ? `<div class="notice warn">${esc(marks.note)}</div>` : '';
  marks.note = '';

  if (!marks.items.length) {
    $('#bTable').innerHTML =
      '<tbody><tr><td class="empty">관심목록에 담은 물품이 없습니다. <b>등록품목</b>·<b>거래내역</b> 검색 결과에서 ★ 를 눌러 담아 주세요.</td></tr></tbody>';
    return;
  }
  const shown = marksVisible();
  if (!shown.length) {
    $('#bTable').innerHTML = `<tbody><tr><td class="empty">"${esc($('#mFind').value)}" 에 맞는 물품이 없습니다.</td></tr></tbody>`;
    return;
  }
  const full = k >= CMP_MAX;
  const row = (x) => {
    const on = cmp.picked.includes(x.id);
    const off = x.missing || (!on && full);
    const notes = [x.kind === 'order' && '거래에서 담음', x.delisted && '계약 끝남·내려감', x.missing].filter(Boolean);
    return `<tr class="${on ? 'mk-on' : ''}">
      <td><input type="checkbox" data-pick value="${x.id}"${on ? ' checked' : ''}${off ? ' disabled' : ''} title="${
        x.missing ? '찾지 못한 물품은 비교할 수 없습니다' : off ? `최대 ${CMP_MAX}개까지 비교할 수 있습니다` : '비교할 물품으로 체크'
      }" /></td>
      <td>${x.missing ? '<span class="thumb none"></span>' : productThumb(x)}</td>
      <td class="nowrap">${esc(x.corp_nm || '')}</td>
      <td>${x.missing ? esc(x.title || '') : esc(specRest(x))}${notes.length ? `<div class="muted small">${esc(notes.join(' · '))}</div>` : ''}</td>
      <td class="num nowrap">${x.price > 0 ? `<b>${n(x.price)}원</b><span class="muted small">/${esc(x.unit || '')}</span>` : ''}</td>
      <td><input type="text" data-memo="${x.id}" value="${esc(x.memo || '')}" placeholder="메모" /></td>
      <td><button class="btn" data-del="${x.id}">삭제</button></td>
    </tr>`;
  };
  const body = shown
    .map(([g, xs]) => (marks.dtil ? '' : `<tr class="mk-group"><th colspan="7">${esc(g)} <span class="muted small">${n(xs.length)}개</span></th></tr>`) + xs.map(row).join(''))
    .join('');
  $('#bTable').innerHTML = `<thead><tr><th class="mk-cb"></th><th class="mk-img">사진</th><th>업체</th><th>규격</th><th class="num">단가</th><th>메모</th><th></th></tr></thead><tbody>${body}</tbody>`;
}

/* ── 설정 ─────────────────────────────────────────────────────── */

async function loadSettings() {
  const s = await api('/settings');
  state.settings = s;
  $('#setMock').checked = s.forceMock;
  $('#setLimit').value = s.dailyLimit;
  $('#setAutoFill').checked = s.autoFill;
  $('#setAutoMax').value = s.autoFillMaxDays;
  $('#setBase').value = s.baseUrl;
  $('#setKey').placeholder = s.serviceKeyFromEnv
    ? '.env 의 G2B_SERVICE_KEY 를 쓰는 중입니다'
    : s.hasServiceKey
      ? '저장된 키가 있습니다 (다시 입력하면 교체)'
      : '일반 인증키(Decoding)';
  $('#setKey').disabled = s.serviceKeyFromEnv;

  loadClsfcInfo();
  loadCorpLocInfo();

  $('#corpRows').innerHTML = '';
  (s.myCorps.length ? s.myCorps : [{ name: '', bizno: '' }]).forEach(addCorpRow);

  const u = await api('/usage');
  $('#usageTable').innerHTML = tableHtml(
    [{ label: '오퍼레이션' }, { label: '호출 수', num: true }],
    u.rows,
    (r) => `<tr><td>${esc(r.operation)}</td><td class="num">${n(r.cnt)}</td></tr>`
  );
  renderBadges();
}

function addCorpRow(c) {
  const div = document.createElement('div');
  div.className = 'corprow';
  div.innerHTML = `
    <input type="text" class="cName" placeholder="업체명 (예: 한빛산업(주))" value="${esc(c?.name || '')}" />
    <input type="text" class="cBizno" placeholder="사업자등록번호 (숫자만)" value="${esc(c?.bizno || '')}" />
    <button class="btn" type="button">삭제</button>`;
  div.querySelector('button').addEventListener('click', () => div.remove());
  $('#corpRows').appendChild(div);
}

async function saveCorps() {
  const myCorps = $$('#corpRows .corprow')
    .map((row) => ({
      name: row.querySelector('.cName').value.trim(),
      bizno: row.querySelector('.cBizno').value.replace(/[^0-9]/g, ''),
    }))
    .filter((c) => c.name || c.bizno);
  await save({ myCorps });
  alert('저장했습니다.');
}

async function saveKey() {
  const key = $('#setKey').value.trim();
  if (!key) return alert('인증키를 입력하세요.');
  await save({ serviceKey: key });
  $('#setKey').value = '';
  alert('저장했습니다. 이제 실데이터로 조회합니다.');
}

async function save(patch) {
  state.settings = await api('/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  await refreshMeta();
  renderBadges();
}

/* ── 시작 ─────────────────────────────────────────────────────── */

boot().catch((err) => {
  document.body.insertAdjacentHTML(
    'afterbegin',
    `<div class="notice err" style="margin:16px">시작 중 오류: ${esc(err.message)}</div>`
  );
});
