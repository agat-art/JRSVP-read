// 簡易サービスワーカー: アプリ本体 (HTML/JS/アイコン) だけをキャッシュする。
// 形態素解析の辞書 (kuromoji.js) はCDNから読み込むため、辞書のダウンロードには
// 初回起動時にネット接続が必要。一度開いたページの見た目は次回オフラインでも
// 表示できるが、ファイルの解析には基本的にネット接続が必要になる点に注意。
//
// CACHE_NAME は app.js / index.html を更新するたびにバージョン番号を
// 上げること (古いキャッシュが優先されて更新が反映されない事故を防ぐため)。

const CACHE_NAME = "jrsvp-shell-v3";
const SHELL_FILES = [
  "./",
  "./index.html",
  "./app.js",
  "./manifest.json",
  "./icon-180.png",
  "./icon-192.png",
  "./icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // 同一オリジンのアプリ本体だけをキャッシュ優先で返す。CDN等の外部リクエストは
  // 素通しする (キャッシュしようとすると辞書の巨大なファイルまで保持してしまうため)。
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(event.request).then((cached) => cached || fetch(event.request))
    );
  }
});
