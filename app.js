/* =====================================================================
   日本語 RSVP リーダー (Web版) - app.js
   macOSアプリ版 (jrsvp_gui.py) と同じ文節結合ロジックをJSに移植。
   形態素解析は kuromoji.js (ブラウザで動く純JS実装) を使用し、
   サーバーを使わずブラウザだけで完結する。

   このファイルは index.html から <script src="app.js" defer> で読み込まれる。
   ===================================================================== */

const ATTACH_TO_PREV_POS = new Set(["助詞", "助動詞", "接尾"]);
const PUNCT_RE = /^[。、！？!?]+$/;
const CLOSING_BRACKETS = new Set(["」", ")", "』", "”", "’", "》", "〉", "］", "】", "＞", "〕", '"', "'"]);
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

function orpPosition(word) {
  const len = word.length;
  if (len <= 1) return 0;
  let pos = Math.round(len * 0.35);
  if (pos < 0) pos = 0;
  if (pos >= len) pos = len - 1;
  return pos;
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
  tokenizer: null,
  tokenizerPromise: null,
  chunks: [],
  index: 0,
  wpm: 400,
  paused: true,
  timerId: null,
  fontFamily: els.fontFamily.value,
  fontSize: parseInt(els.fontSize.value, 10),
  fileKey: null, // localStorage上の進捗保存キー
};

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

  const chunk = state.chunks[state.index].text;
  const orp = orpPosition(chunk);
  const left = chunk.slice(0, orp);
  const center = chunk[orp];
  const right = chunk.slice(orp + 1);

  const cx = w / 2;
  const cy = h / 2 - 10;

  ctx.font = `${state.fontSize}px ${state.fontFamily}`;
  ctx.textBaseline = "middle";

  const centerW = ctx.measureText(center).width;

  // ガイドライン (ORP位置の目印)
  ctx.strokeStyle = "#3a4054";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(cx, cy - state.fontSize * 0.9);
  ctx.lineTo(cx, cy - state.fontSize * 0.55);
  ctx.moveTo(cx, cy + state.fontSize * 0.55);
  ctx.lineTo(cx, cy + state.fontSize * 0.9);
  ctx.stroke();

  ctx.fillStyle = "#e8e5da";
  ctx.textAlign = "right";
  ctx.fillText(left, cx - centerW / 2, cy);

  ctx.fillStyle = "#e2543b";
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

/* =====================================================================
   kuromoji 辞書の読み込み (課題1対応: CDNフォールバック)

   KUROMOJI_CDNS (index.html側で定義) を先頭から順に試し、
   スクリプト読み込み・辞書ビルドのどちらかが失敗したら次のCDNに切り替える。
   全て失敗した場合はユーザーに「再試行」ボタンを出す。
   ===================================================================== */

function buildTokenizerWithDicPath(dicPath) {
  return new Promise((resolve, reject) => {
    if (typeof kuromoji === "undefined") {
      reject(new Error("kuromoji本体が読み込まれていません"));
      return;
    }
    try {
      kuromoji.builder({ dicPath }).build((err, tokenizer) => {
        if (err) { reject(err); return; }
        resolve(tokenizer);
      });
    } catch (syncErr) {
      // dicPath不正やzlib展開失敗などで build() 呼び出し自体が
      // 同期的に例外を投げるケースに対応 (コールバックが永遠に呼ばれないのを防ぐ)
      reject(syncErr);
    }
  });
}

// 辞書ビルドが何らかの理由 (CORS、ネットワーク不調、gzip展開失敗など) で
// コールバックを一切呼ばずに固まってしまうケースがあるため、
// 一定時間で強制的にタイムアウトさせ、次のCDNへ切り替えられるようにする。
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`タイムアウト (${label}): ${ms}ms以内に応答がありませんでした`));
    }, ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

async function ensureTokenizer() {
  if (state.tokenizer) return state.tokenizer;
  if (state.tokenizerPromise) return state.tokenizerPromise;

  state.tokenizerPromise = (async () => {
    let lastErr = null;
    for (const cdn of KUROMOJI_CDNS) {
      try {
        els.statusText.textContent = `辞書を読み込み中... (${cdn.label})`;
        await withTimeout(loadScriptOnce(cdn.scriptUrl), 8000, `${cdn.label} スクリプト`);
        const tokenizer = await withTimeout(
          buildTokenizerWithDicPath(cdn.dicPath), 20000, `${cdn.label} 辞書ビルド`
        );
        state.tokenizer = tokenizer;
        return tokenizer;
      } catch (e) {
        console.warn(`kuromoji CDN失敗 (${cdn.label}):`, e);
        lastErr = e;
        els.statusText.textContent = `${cdn.label} で失敗。次のCDNを試します...`;
        // 失敗したスクリプトタグは次回再試行時に再ロードできるよう削除する
        document.querySelectorAll(`script[data-kuromoji-src="${cdn.scriptUrl}"]`)
          .forEach((s) => s.remove());
        if (typeof kuromoji !== "undefined") {
          try { delete window.kuromoji; } catch (_) { /* ignore */ }
        }
        continue;
      }
    }
    throw lastErr || new Error("すべてのCDNで辞書読み込みに失敗しました");
  })();

  try {
    return await state.tokenizerPromise;
  } finally {
    state.tokenizerPromise = null;
  }
}

/* ---- ファイル読み込み・形態素解析 ---- */
async function loadText(text, fileKey) {
  els.dropHint.style.display = "none";
  els.statusText.textContent = "解析中...";
  clearTimer();

  let tokenizer;
  try {
    tokenizer = await ensureTokenizer();
  } catch (e) {
    els.statusText.textContent = "辞書の読み込みに失敗しました。";
    els.dropHintText.textContent =
      "辞書の読み込みに失敗しました。ネット接続を確認のうえ、" +
      "下のボタンで再試行してください (複数のCDNを順番に試します)。";
    els.retryDictBtn.style.display = "inline-block";
    els.retryDictBtn.dataset.pendingText = text;
    els.retryDictBtn.dataset.pendingKey = fileKey;
    els.dropHint.style.display = "flex";
    return;
  }

  els.retryDictBtn.style.display = "none";

  const tokens = tokenizer.tokenize(text);
  const morphs = tokens.map(t => ({ surface: t.surface_form, pos: t.pos }));

  let chunkRecords = bunsetsuChunk(morphs);
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
  const text = els.retryDictBtn.dataset.pendingText;
  const key = els.retryDictBtn.dataset.pendingKey;
  if (typeof text === "string") {
    loadText(text, key);
  } else {
    // 保留中のファイルが無い場合は、単に辞書だけ先読みしておく
    els.statusText.textContent = "辞書を再読み込み中...";
    ensureTokenizer()
      .then(() => { els.statusText.textContent = "辞書の読み込みに成功しました。ファイルを開いてください。"; els.retryDictBtn.style.display = "none"; })
      .catch(() => { els.statusText.textContent = "再試行しましたが、読み込みに失敗しました。"; });
  }
});

function fileKeyFor(file) {
  // ブラウザではファイルの絶対パスが取れないため、名前+サイズ+更新日時を
  // キーにして「同じファイル」を識別する (簡易的だが実用上十分)。
  return `${file.name}:${file.size}:${file.lastModified || 0}`;
}

els.fileInput.addEventListener("change", (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => loadText(reader.result, fileKeyFor(file));
  reader.onerror = () => { els.statusText.textContent = "ファイルを読み込めませんでした。"; };
  reader.readAsText(file, "UTF-8");
  // 同じファイルを連続で選び直せるよう、毎回値をリセットしておく
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

/* タップでも再生中央キャンバスで一時停止/再開できるようにする。
   課題5対応: 誤タップによる意図しない一時停止を減らすため、
   タップ後ごく短い間隔での連続タップ(誤反応)を無視する。 */
let lastCanvasTapAt = 0;
els.canvas.addEventListener("click", () => {
  const now = Date.now();
  if (now - lastCanvasTapAt < 250) return; // ダブルタップ等のチャタリング防止
  lastCanvasTapAt = now;
  togglePause();
});

/* ---- キーボード操作 (外付けキーボード接続時; Space/矢印/q) ---- */
window.addEventListener("keydown", (e) => {
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return; // 入力中は無効化

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
resizeCanvas();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

// 起動直後にバックグラウンドで辞書読み込みを開始しておく
// (ファイルを開くまで待たず、先に準備しておくことで実際の解析を速くする)
ensureTokenizer()
  .then(() => {
    if (!state.chunks.length) {
      els.statusText.textContent = "辞書の準備ができました。ファイルを開いてください。";
    }
  })
  .catch(() => {
    els.statusText.textContent = "辞書の事前読み込みに失敗しました (ファイルを開く際に再試行します)。";
  });
