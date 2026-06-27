/* =====================================================================
   kuromoji-worker.js  [自己ホスト辞書対応版]

   【今回の修正の経緯】
   kuromoji.js (v0.1.2) は内部で Node.js の path.join() を使って
   dicPath とファイル名を連結している。path.join は "https://" のような
   絶対URLに含まれる "//" を 1本の "/" に潰してしまう仕様があり、
   これにより外部CDN(jsdelivr/unpkg/cdnjsなど)の辞書ファイルへの
   リクエストが必ず壊れたURLになってしまい、404になることが判明した。
   (どのCDNを使っても同じ理由で必ず失敗するため、CDNフォールバックや
   タイムアウト処理では解決できなかった)

   この path.join のバグは「絶対URL」を渡したときにのみ発生するため、
   自分のサイト内の「相対パス」(例: "dict/", "lib/kuromoji.js") を
   渡せば問題が起きない。そのため、辞書ファイル本体・kuromoji.js本体を
   このリポジトリ (web/lib/kuromoji.js, web/dict/*.dat.gz) に同梱し、
   それを最優先で読み込むようにした。CDNは「万が一自己ホストファイルが
   見つからない場合の最終手段」としてのみ残してある(同じバグで
   失敗する可能性が高いことは把握済み)。
   ===================================================================== */

const SELF_HOSTED = {
  label: "自己ホスト (リポジトリ同梱)",
  scriptUrl: "lib/kuromoji.js", // worker自身 (web/kuromoji-worker.js) からの相対パス
  dicPath: "dict/",             // 同上。相対パスなのでpath.joinのバグを回避できる
};

const FALLBACK_CDNS = [
  {
    label: "jsdelivr",
    scriptUrl: "https://cdn.jsdelivr.net/npm/kuromoji@0.1.2/build/kuromoji.js",
    dicPath: "https://cdn.jsdelivr.net/npm/kuromoji@0.1.2/dict/",
  },
  {
    label: "unpkg",
    scriptUrl: "https://unpkg.com/kuromoji@0.1.2/build/kuromoji.js",
    dicPath: "https://unpkg.com/kuromoji@0.1.2/dict/",
  },
];

const ALL_SOURCES = [SELF_HOSTED, ...FALLBACK_CDNS];

let tokenizer = null;
let initStarted = false;

function postStatus(label) {
  postMessage({ type: "status", label });
}

function tryNext(index) {
  if (index >= ALL_SOURCES.length) {
    postMessage({
      type: "init_error",
      error: "自己ホスト辞書・CDNのいずれからも辞書を読み込めませんでした",
    });
    return;
  }
  const src = ALL_SOURCES[index];
  postStatus(`辞書を読み込み中... (${src.label})`);

  try {
    if (typeof self.kuromoji !== "undefined") {
      try { delete self.kuromoji; } catch (_) { self.kuromoji = undefined; }
    }
    importScripts(src.scriptUrl);
  } catch (e) {
    console.warn(`[worker] スクリプト読み込み失敗 (${src.label}):`, e);
    tryNext(index + 1);
    return;
  }

  if (typeof self.kuromoji === "undefined") {
    console.warn(`[worker] kuromoji本体が定義されていません (${src.label})`);
    tryNext(index + 1);
    return;
  }

  let settled = false;
  const timeoutId = setTimeout(() => {
    if (settled) return;
    settled = true;
    console.warn(`[worker] 辞書ビルドがタイムアウト (${src.label})`);
    tryNext(index + 1);
  }, 25000);

  try {
    self.kuromoji.builder({ dicPath: src.dicPath }).build((err, tk) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      if (err) {
        console.warn(`[worker] 辞書ビルド失敗 (${src.label}):`, err);
        tryNext(index + 1);
        return;
      }
      tokenizer = tk;
      postMessage({ type: "ready", source: src.label });
    });
  } catch (syncErr) {
    if (settled) return;
    settled = true;
    clearTimeout(timeoutId);
    console.warn(`[worker] 辞書ビルド呼び出しで例外 (${src.label}):`, syncErr);
    tryNext(index + 1);
  }
}

self.onmessage = function (e) {
  const msg = e.data || {};

  if (msg.type === "init") {
    if (initStarted) return;
    initStarted = true;
    tryNext(0);
    return;
  }

  if (msg.type === "tokenize") {
    if (!tokenizer) {
      postMessage({ type: "tokenize_error", id: msg.id, error: "辞書が未準備です" });
      return;
    }
    try {
      const tokens = tokenizer.tokenize(msg.text);
      const simplified = tokens.map((t) => ({ surface: t.surface_form, pos: t.pos }));
      postMessage({ type: "tokenize_result", id: msg.id, tokens: simplified });
    } catch (err) {
      postMessage({ type: "tokenize_error", id: msg.id, error: String(err) });
    }
  }
};
