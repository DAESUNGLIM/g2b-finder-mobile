/**
 * 모바일 검색용 — 앱 화면 파일을 휴대폰에 담아 두어, 인터넷이 없어도 열리게 한다.
 * (자료는 worker.js 가 OPFS 에 따로 둔다.) 빌드할 때 a9377c67f10e 가 버전으로 바뀐다 — 새 버전이면 새로 담는다.
 */
const CACHE = 'g2b-mobile-__BUILD__';

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => fetch('files.json').then((r) => r.json()).then((files) => c.addAll(files)))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('g2b-mobile-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 같은 사이트의 화면 파일: 인터넷이 되면 새 것을, 안 되면 담아 둔 것을
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((r) => {
        if (r.ok) caches.open(CACHE).then((c) => c.put(e.request, r.clone()));
        return r;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('./')))
  );
});
