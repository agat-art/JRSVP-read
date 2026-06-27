/* =====================================================================
   日本語 RSVP リーダー (Web版) - app.js  [Web Worker対応・修正版]

   【今回の修正点】
   これまで kuromoji.js の辞書読み込み・構築をメインスレッドで実行していたため、
   その間UIが完全にブロックされ「画面は出るがボタンが一切反応しない」
   フリーズが発生していた。これを解消するため、辞書の読み込み・構築・
   形態素解析(tokenize)を kuromoji-worker.js (Web Worker) に完全に移し、
   メインスレッドは Worker にメッセージを送って結果を受け取るだけにした。
   これにより、辞書構築中も画面・ボタンは常に操作可能になる。
   ===================================================================== */

const ATTACH_TO_PREV_POS = new Set(["助詞", "助動詞", "接尾"]);
const PUNCT_RE = /^[。、！？!?]+$/;
const CLOSING_BRACKETS = new Set(["」", ")", "』", "”", "’", "》", "〉", "］", "【", "＞", "〕", '"', "'"]);
const OPENING_BRACKETS = new Set(["「", "(", "『", "“", "‘", "《", "〈", "［", "【", "＜", "〔"]);

function bunsetsuChunk(morphs) {
  const chunks = [];
  let curText = "";
  let curMorphs = [];
  let forceAttachNext = false;

  function flush() {
    if (curText) chunks.push({ text: curText, morphs: curMorphs });
    curText = "";
    curMorphs = [];
  }

  for (const m of morphs) {
    const surface = m.surface;
    const pos = m.pos;
    const isPunct = PUNCT_RE.test(surface);
    const isClosing = CLOSING_BRACKETS.has(surface);
    const isOpening = OPENING_BRACKETS.has(surface);

    if (curText === "") {
      curText = surface;
      curMorphs.push(m);
      forceAttachNext = isOpening;
    } else if (ATTACH_TO_PREV_POS.has(pos) || isPunct || isClosing || forceAttachNext) {
      curText += surface;
      curMorphs.push(m);
      forceAttachNext = isOpening;
    } else {
      flush();
      curText = surface;
      curMorphs.push(m);
      forceAttachNext = isOpening;
    }

    if (isPunct) {
      flush();
      forceAttachNext = false;
    }
  }
  flush();
  return chunks;
}

function lastPos(c) { return c.morphs.length ? c.morphs[c.morphs.length - 1].pos : ""; }
function firstPos(c) { return c.morphs.length ? c.morphs[0].pos : ""; }
function isNoun(pos) { return pos === "名詞"; }
function endsSentence(text) { return /[。！？!?、,]$/.test(text); }

function mergeShortChunks(chunksIn, shortLen = 4, maxLen = 8) {
  const targetLen = 5;
  let chunks = chunksIn;

  for (let pass = 0; pass < 5; pass++) {
    const result = [];
    let i = 0;
    let changed = false;
    const n = chunks.length;

    while (i < n) {
      const cur = chunks[i];

      if (cur.text.length > shortLen || n === 1) {
        result.push(cur);
        i++;
        continue;
      }

      const prev = result.length ? result[result.length - 1] : null;
      const next = i + 1 < n ? chunks[i + 1] : null;

      const prevOk = prev && !endsSentence(prev.text) && (prev.text.length + cur.text.length) <= maxLen;
      const nextOk = next && !endsSentence(cur.text) && (cur.text.length + next.text.length) <= maxLen;

      const prevNoun = prevOk && isNoun(lastPos(prev)) && isNoun(firstPos(cur));
      const nextNoun = nextOk && isNoun(lastPos(cur)) && isNoun(firstPos(next));

      if (prevNoun && !nextNoun) {
        prev.text += cur.text;
        prev.morphs = prev.morphs.concat(cur.morphs);
        i++; changed = true;
      } else if (nextNoun && !prevNoun) {
        result.push({ text: cur.text + next.text, morphs: cur.morphs.concat(next.morphs) });
        i += 2; changed = true;
      } else if (prevOk && next && nextOk) {
        const lenPrev = prev.text.length + cur.text.length;
        const lenNext = cur.text.length + next.text.length;
        if (Math.abs(lenPrev - targetLen) <= Math.abs(lenNext - targetLen)) {
          prev.text += cur.text;
          prev.morphs = prev.morphs.concat(cur.morphs);
          i++;
        } else {
          result.push({ text: cur.text + next.text, morphs: cur.morphs.concat(next.morphs) });
          i += 2;
        }
        changed = true;
      } else if (prevOk) {
        prev.text += cur.text;
        prev.morphs = prev.morphs.concat(cur.morphs);
        i++; changed = true;
      } else if (nextOk) {
        result.push({ text: cur.text + next.text, morphs: cur.morphs.concat(next.morphs) });
        i += 2; changed = true;
      } else {
        result.push(cur);
        i++;
      }
    }
    chunks = result;
    if (!changed) break;
  }
  return chunks;
}

function orpPosition(len) {
  // len はコードポイント数 (サロゲートペアを1文字として数えた長さ)
  if (len <= 1) return 0;
  let pos = Math.round(len * 0.35);
  if (pos < 0) pos = 0;
  if (pos >= len) pos = len - 1;
  return pos;
}

// 稀な漢字・記号・絵文字などはUTF-16で2コードユニット(サロゲートペア)に
// なることがある。.length や .slice() はコードユニット単位のため、
// そのまま使うとペアの真ん中で文字が分断されてしまい、ORP表示の位置が
// おかしくなる(文字が右に寄り、左に空白ができる)原因になっていた。
// Array.from() はコードポイント単位で分割するため、この問題を回避できる。
function toCodePointArray(str) {
  return Array.from(str);
}

function durationMsFor(chunk, wpm) {
  const len = Math.max(1, chunk.length);
  const base = 60.0 / wpm;
  let dur = base * (0.6 + 0.4 * len);
  if (/[。！？!?]$/.test(chunk)) dur += 0.30;
  else if (/[、,]$/.test(chunk)) dur += 0.12;
  dur = Math.max(dur, 0.04);
  return Math.round(dur * 1000);
}

/* ===================== アプリ本体 ===================== */

const els = {
  canvas: document.getElementById("readerCanvas"),
  dropHint: document.getElementById("dropHint"),
  dropHintText: document.getElementById("dropHintText"),
  retryDictBtn: document.getElementById("retryDictBtn"),
  openFileBtn: document.getElementById("openFileBtn"),
  fileInput: document.getElementById("fileInput"),
  gearBtn: document.getElementById("gearBtn"),
  settingsPanel: document.getElementById("settingsPanel"),
  fontFamily: document.getElementById("fontFamily"),
  fontFamilyCustom: document.getElementById("fontFamilyCustom"),
  fontSize: document.getElementById("fontSize"),
  fontSizeLabel: document.getElementById("fontSizeLabel"),
  colorMode: document.getElementById("colorMode"),
  confirmFontBtn: document.getElementById("confirmFontBtn"),
  jumpInput: document.getElementById("jumpInput"),
  jumpBtn: document.getElementById("jumpBtn"),
  statusText: document.getElementById("statusText"),
  wpmText: document.getElementById("wpmText"),
  progressFill: document.getElementById("progressFill"),
  playPauseBtn: document.getElementById("playPauseBtn"),
  seekBackBtn: document.getElementById("seekBackBtn"),
  seekFwdBtn: document.getElementById("seekFwdBtn"),
  speedUpBtn: document.getElementById("speedUpBtn"),
  speedDownBtn: document.getElementById("speedDownBtn"),
};

const ctx = els.canvas.getContext("2d");

const state = {
  chunks: [],
  index: 0,
  wpm: 400,
  paused: true,
  timerId: null,
  fontFamily: els.fontFamily.value,
  fontSize: parseInt(els.fontSize.value, 10),
  monoColor: localStorage.getItem("jrsvp_mono_color") === "1",
  fileKey: null, // localStorage上の進捗保存キー
  dictReady: false,
  pendingTokenizeId: 0,
  pendingTokenizeResolvers: new Map(),
  pendingLoad: null, // 辞書未準備で待たされているファイル { text, fileKey }
};

/* ---------------------------------------------------------------------
   Web Worker (kuromoji-worker.js) との通信
   --------------------------------------------------------------------- */
const dictWorker = new Worker("kuromoji-worker.js");

dictWorker.onmessage = (e) => {
  const msg = e.data || {};

  switch (msg.type) {
    case "status":
      // 辞書未準備時のみステータス表示を更新 (解析中の文言を上書きしないため)
      if (!state.chunks.length) els.statusText.textContent = msg.label;
      break;

    case "ready":
      state.dictReady = true;
      els.retryDictBtn.style.display = "none";
      if (!state.chunks.length) {
        els.statusText.textContent = "辞書の準備ができました。ファイルを開いてください。";
      }
      // 辞書待ちで保留されていたファイルがあれば処理を再開する
      if (state.pendingLoad) {
        const { text, fileKey } = state.pendingLoad;
        state.pendingLoad = null;
        loadText(text, fileKey);
      }
      break;

    case "init_error":
      state.dictReady = false;
      els.statusText.textContent = "辞書の読み込みに失敗しました。";
      if (state.pendingLoad) {
        showDictError();
      }
      break;

    case "tokenize_result": {
      const resolver = state.pendingTokenizeResolvers.get(msg.id);
      if (resolver) {
        state.pendingTokenizeResolvers.delete(msg.id);
        resolver.resolve(msg.tokens);
      }
      break;
    }

    case "tokenize_error": {
      const resolver = state.pendingTokenizeResolvers.get(msg.id);
      if (resolver) {
        state.pendingTokenizeResolvers.delete(msg.id);
        resolver.reject(new Error(msg.error || "形態素解析に失敗しました"));
      }
      break;
    }
  }
};

dictWorker.onerror = (err) => {
  console.error("[main] dictWorker error:", err);
  state.dictReady = false;
  els.statusText.textContent = "辞書の読み込み処理でエラーが発生しました。";
  if (state.pendingLoad) showDictError();
};

function tokenizeViaWorker(text) {
  return new Promise((resolve, reject) => {
    const id = ++state.pendingTokenizeId;
    state.pendingTokenizeResolvers.set(id, { resolve, reject });
    dictWorker.postMessage({ type: "tokenize", id, text });
  });
}

function showDictError() {
  els.dropHintText.textContent =
    "辞書の読み込みに失敗しました。ネット接続を確認のうえ、" +
    "下のボタンで再試行してください (複数のCDNを順番に試します)。";
  els.retryDictBtn.style.display = "inline-block";
  els.dropHint.style.display = "flex";
}

/* ---- Canvas のリサイズ (Retina対応) ---- */
function resizeCanvas() {
  const rect = els.canvas.parentElement.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  els.canvas.width = rect.width * dpr;
  els.canvas.height = rect.height * dpr;
  els.canvas.style.width = rect.width + "px";
  els.canvas.style.height = rect.height + "px";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  render();
}
window.addEventListener("resize", resizeCanvas);

/* ---- 描画 (ORPを揃えて中央表示) ---- */
function render() {
  const w = els.canvas.clientWidth;
  const h = els.canvas.clientHeight;
  ctx.clearRect(0, 0, w, h);

  if (!state.chunks.length) return;

  const chunkText = state.chunks[state.index].text;
  const chars = toCodePointArray(chunkText);
  const orp = orpPosition(chars.length);
  const left = chars.slice(0, orp).join("");
  const center = chars[orp];
  const right = chars.slice(orp + 1).join("");

  const cx = w / 2;
  const cy = h / 2 - 10;

  ctx.font = `${state.fontSize}px ${state.fontFamily}`;
  ctx.textBaseline = "middle";

  const centerW = ctx.measureText(center).width;

  ctx.strokeStyle = "#3a4054";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(cx, cy - state.fontSize * 0.9);
  ctx.lineTo(cx, cy - state.fontSize * 0.55);
  ctx.moveTo(cx, cy + state.fontSize * 0.55);
  ctx.lineTo(cx, cy + state.fontSize * 0.9);
  ctx.stroke();

  // 文字色: state.monoColor が true なら中央文字も白(単色)、false なら赤
  const centerColor = state.monoColor ? "#e8e5da" : "#e2543b";

  ctx.fillStyle = "#e8e5da";
  ctx.textAlign = "right";
  ctx.fillText(left, cx - centerW / 2, cy);

  ctx.fillStyle = centerColor;
  ctx.textAlign = "center";
  ctx.fillText(center, cx, cy);

  ctx.fillStyle = "#e8e5da";
  ctx.textAlign = "left";
  ctx.fillText(right, cx + centerW / 2, cy);

  const total = state.chunks.length;
  els.statusText.textContent =
    `${state.index + 1} / ${total}` + (state.paused ? "　[一時停止中]" : "");
  els.wpmText.textContent = `${state.wpm} WPM`;
  els.progressFill.style.width = `${((state.index + 1) / total) * 100}%`;
  els.playPauseBtn.textContent = state.paused ? "▶" : "⏸";
}

/* ---- 再生制御 ---- */
function clearTimer() {
  if (state.timerId !== null) {
    clearTimeout(state.timerId);
    state.timerId = null;
  }
}

function showStep() {
  if (!state.chunks.length) return;
  state.index = Math.max(0, Math.min(state.index, state.chunks.length - 1));
  render();
  if (state.paused) return;

  const dur = durationMsFor(state.chunks[state.index].text, state.wpm);
  state.timerId = setTimeout(advance, dur);
}

function advance() {
  if (state.paused) return;
  if (state.index >= state.chunks.length - 1) {
    state.paused = true;
    render();
    saveProgress();
    return;
  }
  state.index++;
  if (state.index % 20 === 0) saveProgress();
  showStep();
}

function togglePause() {
  if (!state.chunks.length) return;
  state.paused = !state.paused;
  if (state.paused) {
    clearTimer();
    saveProgress();
    render();
  } else {
    showStep();
  }
}

function seek(delta) {
  if (!state.chunks.length) return;
  clearTimer();
  state.index = Math.max(0, Math.min(state.index + delta, state.chunks.length - 1));
  saveProgress();
  if (state.paused) render();
  else showStep();
}

function changeSpeed(delta) {
  state.wpm = Math.max(60, state.wpm + delta);
  render();
}

function jumpToInput() {
  if (!state.chunks.length) return;
  const n = parseInt(els.jumpInput.value, 10);
  if (!Number.isFinite(n)) return;
  const total = state.chunks.length;
  const idx = Math.max(1, Math.min(n, total)) - 1;
  clearTimer();
  state.index = idx;
  saveProgress();
  if (state.paused) render();
  else showStep();
  els.jumpInput.blur();
}

/* ---- 進捗の自動保存 (localStorage) ---- */
function saveProgress() {
  if (!state.fileKey || !state.chunks.length) return;
  try {
    const db = JSON.parse(localStorage.getItem("jrsvp_progress") || "{}");
    db[state.fileKey] = state.index;
    localStorage.setItem("jrsvp_progress", JSON.stringify(db));
  } catch (e) { /* ignore */ }
}
function loadProgress(key) {
  try {
    const db = JSON.parse(localStorage.getItem("jrsvp_progress") || "{}");
    return db[key];
  } catch (e) { return undefined; }
}

/* ---- ファイル読み込み・形態素解析 (Worker経由) ---- */
async function loadText(text, fileKey) {
  els.dropHint.style.display = "none";

  if (!state.dictReady) {
    // 辞書がまだ準備できていない場合は、準備完了後に自動で処理を再開する
    state.pendingLoad = { text, fileKey };
    els.statusText.textContent = "辞書の準備中です。準備ができたら自動的に解析を始めます...";
    return;
  }

  els.statusText.textContent = "解析中...";
  clearTimer();

  let tokens;
  try {
    tokens = await tokenizeViaWorker(text);
  } catch (e) {
    console.error(e);
    els.statusText.textContent = "解析中にエラーが発生しました。";
    els.dropHint.style.display = "flex";
    return;
  }

  let chunkRecords = bunsetsuChunk(tokens);
  chunkRecords = mergeShortChunks(chunkRecords);
  const chunks = chunkRecords.filter(c => c.text);

  if (!chunks.length) {
    els.statusText.textContent = "表示できる文節がありませんでした。";
    els.dropHint.style.display = "flex";
    return;
  }

  state.chunks = chunks;
  state.fileKey = fileKey;
  state.paused = true;

  const saved = loadProgress(fileKey);
  const total = chunks.length;
  if (typeof saved === "number" && saved > 0 && saved < total - 1) {
    const resume = window.confirm(
      `前回の続き (${saved + 1} / ${total}) から再生しますか？\n` +
      `「キャンセル」を選ぶと最初から再生します。`
    );
    state.index = resume ? saved : 0;
  } else {
    state.index = 0;
  }

  resizeCanvas();
  render();
}

els.retryDictBtn.addEventListener("click", () => {
  els.retryDictBtn.style.display = "none";
  els.statusText.textContent = "辞書を再読み込み中...";
  // Workerを使い捨てにして再生成すると確実に状態がリセットされる
  location.reload();
});

function fileKeyFor(file) {
  return `${file.name}:${file.size}:${file.lastModified || 0}`;
}

// 文字コード判定: まずUTF-8として厳密(fatal: 不正なバイト列ならエラー)に
// デコードを試す。Shift_JISのテキストをUTF-8として読むと、ほぼ必ずこの
// 厳密デコードでエラーになるため、それを「Shift_JISらしい」の判定に使う。
// (重い自前の文字コード判定処理を書かず、ブラウザ標準のTextDecoderの
//  機能だけで判定できるため、アプリを重くしない簡潔な方法として採用)
function decodeFileBuffer(buffer) {
  try {
    const utf8 = new TextDecoder("utf-8", { fatal: true });
    let text = utf8.decode(buffer);
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // BOM除去
    return { text, encoding: "UTF-8" };
  } catch (e) {
    // UTF-8として不正 → Shift_JISとして読み直す
    const sjis = new TextDecoder("shift_jis");
    const text = sjis.decode(buffer);
    return { text, encoding: "Shift_JIS" };
  }
}

els.fileInput.addEventListener("change", (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    let decoded;
    try {
      decoded = decodeFileBuffer(reader.result);
    } catch (err) {
      els.statusText.textContent = "文字コードを判別できず、読み込めませんでした。";
      return;
    }
    if (decoded.encoding === "Shift_JIS") {
      els.statusText.textContent = "Shift_JISの文字コードとして読み込みました。解析中...";
    }
    loadText(decoded.text, fileKeyFor(file));
  };
  reader.onerror = () => { els.statusText.textContent = "ファイルを読み込めませんでした。"; };
  reader.readAsArrayBuffer(file);
  els.fileInput.value = "";
});

els.openFileBtn.addEventListener("click", () => els.fileInput.click());

/* ---- 設定パネル ---- */
els.gearBtn.addEventListener("click", () => {
  els.settingsPanel.classList.toggle("open");
});

els.fontFamily.addEventListener("change", () => {
  els.fontFamilyCustom.style.display = els.fontFamily.value === "__custom__" ? "block" : "none";
});

els.fontSize.addEventListener("input", () => {
  els.fontSizeLabel.textContent = `${els.fontSize.value}px`;
});

els.confirmFontBtn.addEventListener("click", () => {
  state.fontFamily = els.fontFamily.value === "__custom__"
    ? (els.fontFamilyCustom.value.trim() || state.fontFamily)
    : els.fontFamily.value;
  state.fontSize = parseInt(els.fontSize.value, 10);
  state.monoColor = els.colorMode.value === "mono";
  try { localStorage.setItem("jrsvp_mono_color", state.monoColor ? "1" : "0"); } catch (e) { /* ignore */ }
  render();
  els.settingsPanel.classList.remove("open");
  els.confirmFontBtn.blur();
});

els.jumpBtn.addEventListener("click", () => { jumpToInput(); els.jumpBtn.blur(); });
els.jumpInput.addEventListener("keydown", (e) => { if (e.key === "Enter") jumpToInput(); });

/* ---- トランスポート(タップ操作) ---- */
els.playPauseBtn.addEventListener("click", () => { togglePause(); els.playPauseBtn.blur(); });
els.seekBackBtn.addEventListener("click", () => { seek(-1); els.seekBackBtn.blur(); });
els.seekFwdBtn.addEventListener("click", () => { seek(1); els.seekFwdBtn.blur(); });
els.speedUpBtn.addEventListener("click", () => { changeSpeed(20); els.speedUpBtn.blur(); });
els.speedDownBtn.addEventListener("click", () => { changeSpeed(-20); els.speedDownBtn.blur(); });

let lastCanvasTapAt = 0;
els.canvas.addEventListener("click", () => {
  const now = Date.now();
  if (now - lastCanvasTapAt < 250) return;
  lastCanvasTapAt = now;
  togglePause();
});

window.addEventListener("keydown", (e) => {
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;

  switch (e.key) {
    case " ":
      e.preventDefault();
      togglePause();
      break;
    case "ArrowLeft":
      e.preventDefault();
      seek(-1);
      break;
    case "ArrowRight":
      e.preventDefault();
      seek(1);
      break;
    case "ArrowUp":
      e.preventDefault();
      changeSpeed(20);
      break;
    case "ArrowDown":
      e.preventDefault();
      changeSpeed(-20);
      break;
  }
});

/* ---- 初期化 ---- */
els.colorMode.value = state.monoColor ? "mono" : "red";
resizeCanvas();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

// メインスレッドをブロックせず、Workerに辞書の準備を指示する
els.statusText.textContent = "辞書を準備中です...";
dictWorker.postMessage({ type: "init" });
