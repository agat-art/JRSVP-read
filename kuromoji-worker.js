/* =====================================================================
   kuromoji-worker.js

   【このファイルを新規追加した理由】
   これまで kuromoji.js の辞書ダウンロード・辞書構築(トライ木のパース等)
   はメインスレッド上で実行していた。この構築処理は重いCPU処理であり、
   実行中はメインスレッドが完全にブロックされる。その結果:
     - 画面は表示されるがボタンが一切反応しない
     - しばらくするとブラウザが「ページが応答していません」と警告を出す
   という、これまで報告されていた「フリーズ」現象の直接の原因になっていた。
   (ネットワークやService Workerの問題ではなく、メインスレッドの占有が原因)

   対策として、辞書の読み込み・構築・トークナイズの全工程を
   この Web Worker (別スレッド) の中で行う。メインスレッド (app.js) は
   postMessage でテキストを送り、結果をもらうだけにする。
   これによりUIスレッドは常に空いた状態を保てる。
   ===================================================================== */

const KUROMOJI_CDNS = [
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
  {
    label: "cdnjs (jsdelivr dict)",
    scriptUrl: "https://cdnjs.cloudflare.com/ajax/libs/kuromoji/0.1.2/kuromoji.js",
    dicPath: "https://cdn.jsdelivr.net/npm/kuromoji@0.1.2/dict/",
  },
];

let tokenizer = null;
let initStarted = false;

function postStatus(label) {
  postMessage({ type: "status", label });
}

function tryNext(index) {
  if (index >= KUROMOJI_CDNS.length) {
    postMessage({ type: "init_error", error: "すべてのCDNで辞書読み込みに失敗しました" });
    return;
  }
  const cdn = KUROMOJI_CDNS[index];
  postStatus(`辞書を読み込み中... (${cdn.label})`);

  // Worker内の importScripts は同期実行だが、メインスレッドには影響しない。
  try {
    // 既に別CDNのkuromoji本体を読み込んでいる場合に備え、
    // グローバルの kuromoji 定義をクリアしてから読み込む。
    if (typeof self.kuromoji !== "undefined") {
      try { delete self.kuromoji; } catch (_) { self.kuromoji = undefined; }
    }
    importScripts(cdn.scriptUrl);
  } catch (e) {
    console.warn(`[worker] スクリプト読み込み失敗 (${cdn.label}):`, e);
    tryNext(index + 1);
    return;
  }

  if (typeof self.kuromoji === "undefined") {
    console.warn(`[worker] kuromoji本体が定義されていません (${cdn.label})`);
    tryNext(index + 1);
    return;
  }

  // 辞書ビルドが極端に時間がかかる/応答しないケースに備えたタイムアウト
  let settled = false;
  const timeoutId = setTimeout(() => {
    if (settled) return;
    settled = true;
    console.warn(`[worker] 辞書ビルドがタイムアウト (${cdn.label})`);
    tryNext(index + 1);
  }, 25000);

  try {
    self.kuromoji.builder({ dicPath: cdn.dicPath }).build((err, tk) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      if (err) {
        console.warn(`[worker] 辞書ビルド失敗 (${cdn.label}):`, err);
        tryNext(index + 1);
        return;
      }
      tokenizer = tk;
      postMessage({ type: "ready" });
    });
  } catch (syncErr) {
    if (settled) return;
    settled = true;
    clearTimeout(timeoutId);
    console.warn(`[worker] 辞書ビルド呼び出しで例外 (${cdn.label}):`, syncErr);
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
      // 必要な項目だけ抽出してメインスレッドに返す(転送量を減らす)
      const simplified = tokens.map((t) => ({ surface: t.surface_form, pos: t.pos }));
      postMessage({ type: "tokenize_result", id: msg.id, tokens: simplified });
    } catch (err) {
      postMessage({ type: "tokenize_error", id: msg.id, error: String(err) });
    }
  }
};
