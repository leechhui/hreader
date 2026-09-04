/* ================================================================
 * 简读 · Service Worker —— 离线缓存应用外壳
 *
 * 策略：
 *  · install 预缓存 index.html / manifest / 图标
 *  · 页面导航：网络优先，离线回退缓存
 *  · 静态资源：缓存优先，后台静默刷新
 *  · 跨域请求（链接导入 / 服务器代理）直接放行，不缓存
 *
 * 仅 https / localhost 环境生效；file:// 无法注册 SW。
 * ================================================================ */
const CACHE_NAME = 'hreader-shell-v5';
const SHELL = [
  './index.html',
  './manifest.webmanifest',
  './icon.svg',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(function (cache) { return cache.addAll(SHELL); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (k) { return k !== CACHE_NAME; })
          .map(function (k) { return caches.delete(k); })
      );
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var url;
  try { url = new URL(event.request.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;   /* 跨域请求放行 */
  if (event.request.method !== 'GET') return;

  /* 页面导航：网络优先，离线回退缓存（联网时顺带更新缓存） */
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE_NAME).then(function (cache) { cache.put(event.request, copy); });
        return res;
      }).catch(function () {
        return caches.match('./index.html');
      })
    );
    return;
  }

  /* 静态资源：缓存优先，后台静默刷新 */
  event.respondWith(
    caches.match(event.request).then(function (cached) {
      var network = fetch(event.request).then(function (res) {
        if (res && res.status === 200) {
          var copy = res.clone();
          caches.open(CACHE_NAME).then(function (cache) { cache.put(event.request, copy); });
        }
        return res;
      }).catch(function () { return cached; });
      return cached || network;
    })
  );
});
