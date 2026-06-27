// 簡易サービスワーカー: アプリ本体 (HTML/JS/アイコン) だけをキャッシュする。
// 形態素解析の辞書 (kuromoji.js) はCDNから読み込むため、辞書のダウンロードには
// 初回起動時にネット接続が必要。一度開いたページの見た目は次回オフラインでも
// 表示できるが、ファイルの解析には基本的にネット接続が必要になる点に注意。
//
// CACHE_NAME は app.js / index.html / kuromoji-worker.js を更新するたびに
// バージョン番号を上げること (古いキャッシュが優先されて更新が反映されない
// 事故を防ぐため)。

const CACHE_NAME = "jrsvp-shell-v6";
const SHELL_FILES = [
  "./",
  "./index.html",
  "./app.js",
  "./kuromoji-worker.js",
  "./lib/kuromoji.js",
  "./manifest.json",
  "./icon-180.png",
  "./icon-192.png",
  "./icon-512.png",
];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          return response;
        })
        .catch(() => caches.match(event.request))
    );
  }
});
