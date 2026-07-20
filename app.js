/* =====================================================================
   日本語 RSVP リーダー (Web版) - app.js
   [目次・検索・しおり機能追加版]
   ===================================================================== */

/* ---- 文節結合ロジック ---- */
const ATTACH_TO_PREV_POS = new Set(["助詞", "助動詞", "接尾"]);
const PUNCT_RE = /^[。、！？!?]+$/;
const CLOSING_BRACKETS = new Set(["」",")",  "』", "\u201D", "\u2019", "》", "〉", "］", "】", "＞", "〕", '"', "'"]);
const OPENING_BRACKETS = new Set(["「", "(", "『", "\u201C", "\u2018", "《", "〈", "［", "【", "＜", "〔"]);

function bunsetsuChunk(morphs) {
  const chunks = [];
  let curText = "";
  let curMorphs = [];
  let forceAttachNext = false;

  function flush() {
    if (curText) {
      const charStart = curMorphs.length ? (curMorphs[0].start ?? 0) : 0;
      chunks.push({ text: curText, morphs: curMorphs, charStart });
    }
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
      curText = surface; curMorphs.push(m); forceAttachNext = isOpening;
    } else if (ATTACH_TO_PREV_POS.has(pos) || isPunct || isClosing || forceAttachNext) {
      curText += surface; curMorphs.push(m); forceAttachNext = isOpening;
    } else {
      flush(); curText = surface; curMorphs.push(m); forceAttachNext = isOpening;
    }
    if (isPunct) { flush(); forceAttachNext = false; }
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
    const result = []; let i = 0; let changed = false; const n = chunks.length;
    while (i < n) {
      const cur = chunks[i];
      if (cur.text.length > shortLen || n === 1) { result.push(cur); i++; continue; }
      const prev = result.length ? result[result.length - 1] : null;
      const next = i + 1 < n ? chunks[i + 1] : null;
      const prevOk = prev && !endsSentence(prev.text) && (prev.text.length + cur.text.length) <= maxLen;
      const nextOk = next && !endsSentence(cur.text) && (cur.text.length + next.text.length) <= maxLen;
      const prevNoun = prevOk && isNoun(lastPos(prev)) && isNoun(firstPos(cur));
      const nextNoun = nextOk && isNoun(lastPos(cur)) && isNoun(firstPos(next));
      if (prevNoun && !nextNoun) {
        prev.text += cur.text; prev.morphs = prev.morphs.concat(cur.morphs); i++; changed = true;
      } else if (nextNoun && !prevNoun) {
        result.push({ text: cur.text + next.text, morphs: cur.morphs.concat(next.morphs), charStart: cur.charStart }); i += 2; changed = true;
      } else if (prevOk && next && nextOk) {
        const lenPrev = prev.text.length + cur.text.length, lenNext = cur.text.length + next.text.length;
        if (Math.abs(lenPrev - targetLen) <= Math.abs(lenNext - targetLen)) {
          prev.text += cur.text; prev.morphs = prev.morphs.concat(cur.morphs); i++;
        } else {
          result.push({ text: cur.text + next.text, morphs: cur.morphs.concat(next.morphs), charStart: cur.charStart }); i += 2;
        }
        changed = true;
      } else if (prevOk) {
        prev.text += cur.text; prev.morphs = prev.morphs.concat(cur.morphs); i++; changed = true;
      } else if (nextOk) {
        result.push({ text: cur.text + next.text, morphs: cur.morphs.concat(next.morphs), charStart: cur.charStart }); i += 2; changed = true;
      } else { result.push(cur); i++; }
    }
    chunks = result; if (!changed) break;
  }
  return chunks;
}

function orpPosition(len) {
  if (len <= 1) return 0;
  let pos = Math.round(len * 0.35);
  if (pos < 0) pos = 0;
  if (pos >= len) pos = len - 1;
  return pos;
}
function toCodePointArray(str) { return Array.from(str); }

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
  // 新規
  tocBtn: document.getElementById("tocBtn"),
  searchBtn: document.getElementById("searchBtn"),
  bookmarkBtn: document.getElementById("bookmarkBtn"),
  searchPanel: document.getElementById("searchPanel"),
  searchInput: document.getElementById("searchInput"),
  searchCount: document.getElementById("searchCount"),
  searchPrevBtn: document.getElementById("searchPrevBtn"),
  searchNextBtn: document.getElementById("searchNextBtn"),
  searchCloseBtn: document.getElementById("searchCloseBtn"),
  tocOverlay: document.getElementById("tocOverlay"),
  tocBody: document.getElementById("tocBody"),
  tocCloseBtn: document.getElementById("tocCloseBtn"),
  bookmarkOverlay: document.getElementById("bookmarkOverlay"),
  bookmarkBody: document.getElementById("bookmarkBody"),
  bookmarkCloseBtn: document.getElementById("bookmarkCloseBtn"),
  saveBookmarkBtn: document.getElementById("saveBookmarkBtn"),
  exportBookmarkBtn: document.getElementById("exportBookmarkBtn"),
  importBookmarkBtn: document.getElementById("importBookmarkBtn"),
};

const ctx = els.canvas.getContext("2d");

const state = {
  chunks: [],
  index: 0,
  wpm: 400,
  paused: true,
  timerId: null,
  fontFamily: localStorage.getItem("jrsvp_font_family") || els.fontFamily.value,
  fontSize: parseInt(localStorage.getItem("jrsvp_font_size") || els.fontSize.value, 10),
  monoColor: localStorage.getItem("jrsvp_mono_color") === "1",
  fileKey: null,
  fileName: "",
  originalText: "",
  headings: [],
  searchMatches: [],
  searchMatchIdx: -1,
  dictReady: false,
  pendingTokenizeId: 0,
  pendingTokenizeResolvers: new Map(),
  pendingLoad: null,
};

/* ---- Web Worker ---- */
const dictWorker = new Worker("kuromoji-worker.js");
dictWorker.onmessage = (e) => {
  const msg = e.data || {};
  switch (msg.type) {
    case "status":
      if (!state.chunks.length) els.statusText.textContent = msg.label;
      break;
    case "ready":
      state.dictReady = true;
      els.retryDictBtn.style.display = "none";
      if (!state.chunks.length) els.statusText.textContent = "辞書の準備ができました。ファイルを開いてください。";
      if (state.pendingLoad) {
        const { text, fileKey, fileName } = state.pendingLoad;
        state.pendingLoad = null;
        loadText(text, fileKey, fileName);
      }
      break;
    case "init_error":
      state.dictReady = false;
      els.statusText.textContent = "辞書の読み込みに失敗しました。";
      if (state.pendingLoad) showDictError();
      break;
    case "tokenize_result": {
      const r = state.pendingTokenizeResolvers.get(msg.id);
      if (r) { state.pendingTokenizeResolvers.delete(msg.id); r.resolve(msg.tokens); }
      break;
    }
    case "tokenize_error": {
      const r = state.pendingTokenizeResolvers.get(msg.id);
      if (r) { state.pendingTokenizeResolvers.delete(msg.id); r.reject(new Error(msg.error || "形態素解析に失敗")); }
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
  els.dropHintText.textContent = "辞書の読み込みに失敗しました。ネット接続を確認のうえ、下のボタンで再試行してください。";
  els.retryDictBtn.style.display = "inline-block";
  els.dropHint.style.display = "flex";
}

/* ---- Canvas リサイズ ---- */
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

/* ---- 描画 ---- */
function render() {
  const w = els.canvas.clientWidth, h = els.canvas.clientHeight;
  ctx.clearRect(0, 0, w, h);
  if (!state.chunks.length) return;

  const chars = toCodePointArray(state.chunks[state.index].text);
  const orp = orpPosition(chars.length);
  const left = chars.slice(0, orp).join("");
  const center = chars[orp] || "";
  const right = chars.slice(orp + 1).join("");

  const cx = w / 2, cy = h / 2 - 10;
  ctx.font = `${state.fontSize}px ${state.fontFamily}`;
  ctx.textBaseline = "middle";
  const centerW = ctx.measureText(center).width;

  ctx.strokeStyle = "#3a4054"; ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(cx, cy - state.fontSize * 0.9); ctx.lineTo(cx, cy - state.fontSize * 0.55);
  ctx.moveTo(cx, cy + state.fontSize * 0.55); ctx.lineTo(cx, cy + state.fontSize * 0.9);
  ctx.stroke();

  const centerColor = state.monoColor ? "#e8e5da" : "#e2543b";
  ctx.fillStyle = "#e8e5da"; ctx.textAlign = "right";
  ctx.fillText(left, cx - centerW / 2, cy);
  ctx.fillStyle = centerColor; ctx.textAlign = "center";
  ctx.fillText(center, cx, cy);
  ctx.fillStyle = "#e8e5da"; ctx.textAlign = "left";
  ctx.fillText(right, cx + centerW / 2, cy);

  const total = state.chunks.length;
  els.statusText.textContent = `${state.index + 1} / ${total}` + (state.paused ? "　[一時停止中]" : "");
  els.wpmText.textContent = `${state.wpm} WPM`;
  els.progressFill.style.width = `${((state.index + 1) / total) * 100}%`;
  els.playPauseBtn.textContent = state.paused ? "▶" : "⏸";
}

/* ---- 再生制御 ---- */
function clearTimer() { if (state.timerId !== null) { clearTimeout(state.timerId); state.timerId = null; } }

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
  if (state.index >= state.chunks.length - 1) { state.paused = true; render(); saveProgress(); return; }
  state.index++;
  if (state.index % 20 === 0) saveProgress();
  showStep();
}

function togglePause() {
  if (!state.chunks.length) return;
  state.paused = !state.paused;
  if (state.paused) { clearTimer(); saveProgress(); render(); } else { showStep(); }
}

function seek(delta) {
  if (!state.chunks.length) return;
  clearTimer();
  state.index = Math.max(0, Math.min(state.index + delta, state.chunks.length - 1));
  saveProgress();
  if (state.paused) render(); else showStep();
}

function changeSpeed(delta) { state.wpm = Math.max(60, state.wpm + delta); render(); }

function jumpToChunk(idx) {
  if (!state.chunks.length) return;
  clearTimer();
  state.index = Math.max(0, Math.min(idx, state.chunks.length - 1));
  saveProgress();
  if (state.paused) render(); else showStep();
}

function jumpToInput() {
  if (!state.chunks.length) return;
  const n = parseInt(els.jumpInput.value, 10);
  if (!Number.isFinite(n)) return;
  jumpToChunk(Math.max(1, Math.min(n, state.chunks.length)) - 1);
  els.jumpInput.blur();
}

/* ---- 進捗保存 ---- */
function saveProgress() {
  if (!state.fileKey || !state.chunks.length) return;
  try {
    const db = JSON.parse(localStorage.getItem("jrsvp_progress") || "{}");
    db[state.fileKey] = state.index;
    localStorage.setItem("jrsvp_progress", JSON.stringify(db));
  } catch (e) { /* ignore */ }
}
function loadProgress(key) {
  try { return JSON.parse(localStorage.getItem("jrsvp_progress") || "{}")[key]; } catch (e) { return undefined; }
}

/* =====================================================================
   目次 (TOC) 機能
   ===================================================================== */
// 見出しパターン:
//   章  … 「第X章」で始まる行 (X は漢数字・算用数字混在)
//   節  … 「●」で始まる行
// どちらも短い(50文字以下)行限定。
const CHAPTER_RE = /^第[一二三四五六七八九十百千壱弐参拾〇零\d]+章/;
// 章の直後に「で/が/を/に/も」などの助詞が続く場合は章タイトルではなく文中言及
const CHAPTER_REF_RE = /^第[一二三四五六七八九十百千壱弐参拾〇零\d]+章[でがをにも]/;
const SECTION_RE = /^[●]/;

// 区切り線判定:
// ひらがな・カタカナ・漢字・英字（全角含む）を1文字も含まない行は
// 「——」「---」「＊＊＊」のような装飾的な区切り線とみなす
function isSeparatorLine(text) {
  return !/[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAFa-zA-Z\uFF21-\uFF5A\uFF41-\uFF5A\uFF66-\uFF9F]/.test(text);
}

function extractHeadings(text) {
  const result = [];
  const lines = text.split("\n");
  let offset = 0;
  let prevWasEmpty = true; // 先頭行は「前が空行」扱いにする

  for (let i = 0; i < lines.length; i++) {
    const clean = lines[i].replace(/\r$/, "");
    const trimmed = clean.trim();

    if (trimmed.length > 0 && trimmed.length <= 50) {
      if (CHAPTER_RE.test(trimmed) && !CHAPTER_REF_RE.test(trimmed)) {
        // 「第X章〜」パターン。ただし章の後に助詞が続く文中言及は除外
        result.push({ title: trimmed, charOffset: offset, type: "chapter" });
      } else if (SECTION_RE.test(trimmed)) {
        // 「●」で始まるパターン
        result.push({ title: trimmed, charOffset: offset, type: "section" });
      } else if (prevWasEmpty && trimmed.length <= 20 && !isSeparatorLine(trimmed) && !CHAPTER_REF_RE.test(trimmed)) {
        // 前行が空行 かつ 20文字以内 かつ 区切り線でない かつ 章への言及でない → 見出しと見なす
        result.push({ title: trimmed, charOffset: offset, type: "section" });
      }
    }

    prevWasEmpty = (trimmed.length === 0);
    offset += clean.length + 1; // +1 for '\n'
  }

  return result;
}

function charOffsetToChunkIdx(offset) {
  let result = 0;
  for (let i = 0; i < state.chunks.length; i++) {
    const cs = state.chunks[i].charStart;
    if (typeof cs === "number" && cs <= offset) result = i;
    else if (typeof cs === "number" && cs > offset) break;
  }
  return result;
}

function buildTOC() {
  els.tocBody.innerHTML = "";
  if (!state.chunks.length) {
    els.tocBody.innerHTML = '<p style="padding:16px;color:var(--text-dim);font-size:13px;">ファイルが読み込まれていません。</p>';
    return;
  }
  if (!state.headings.length) {
    els.tocBody.innerHTML = '<p style="padding:16px;color:var(--text-dim);font-size:13px;">章・見出し (●) が見つかりませんでした。<br>テキスト内に「第X章〜」または「●〜」で始まる行があると自動的に目次を生成します。</p>';
    return;
  }
  const frag = document.createDocumentFragment();
  for (const h of state.headings) {
    const btn = document.createElement("button");
    btn.className = "toc-item" + (h.type === "chapter" ? " chapter" : "");
    btn.textContent = h.title;
    const num = document.createElement("span");
    num.className = "toc-num";
    num.textContent = `(${h.chunkIndex + 1}章)`;
    btn.appendChild(num);
    btn.addEventListener("click", () => {
      jumpToChunk(h.chunkIndex);
      closeModal(els.tocOverlay);
    });
    frag.appendChild(btn);
  }
  els.tocBody.appendChild(frag);
}

/* =====================================================================
   検索機能
   ===================================================================== */
function buildSearchMatches(query) {
  if (!query || !state.originalText || !state.chunks.length) return [];
  const matches = [];
  const text = state.originalText;
  let from = 0;
  while (true) {
    const idx = text.indexOf(query, from);
    if (idx < 0) break;
    const chunkIdx = charOffsetToChunkIdx(idx);
    if (!matches.length || matches[matches.length - 1] !== chunkIdx) {
      matches.push(chunkIdx);
    }
    from = idx + 1;
  }
  return matches;
}

function updateSearchUI() {
  const m = state.searchMatches;
  if (!m.length) {
    els.searchCount.textContent = "見つかりません";
  } else {
    els.searchCount.textContent = `${state.searchMatchIdx + 1} / ${m.length}件`;
  }
}

function searchGo(delta) {
  if (!state.searchMatches.length) return;
  const n = state.searchMatches.length;
  state.searchMatchIdx = ((state.searchMatchIdx + delta) % n + n) % n;
  updateSearchUI();
  jumpToChunk(state.searchMatches[state.searchMatchIdx]);
}

function doSearch() {
  const q = els.searchInput.value.trim();
  if (!q) { els.searchCount.textContent = ""; state.searchMatches = []; return; }
  state.searchMatches = buildSearchMatches(q);
  state.searchMatchIdx = state.searchMatches.length ? 0 : -1;
  updateSearchUI();
  if (state.searchMatches.length) jumpToChunk(state.searchMatches[0]);
}

/* =====================================================================
   しおり機能
   ===================================================================== */

// fileKeyは "filename:size:lastModified" の形式。
// lastModified はデバイスや転送方法によって変わるため(iCloud/Google Drive経由など)、
// 別デバイスでインポートした場合にfileKeyが一致しなくなる。
// filename:size の部分だけで同一ファイルと判定することで、この問題を回避する。
function fileKeyBase(key) {
  if (!key) return "";
  const parts = key.split(":");
  return parts.length >= 2 ? parts[0] + ":" + parts[1] : key;
}
const BOOKMARK_KEY = "jrsvp_bookmarks";

function loadAllBookmarks() {
  try { return JSON.parse(localStorage.getItem(BOOKMARK_KEY) || "[]"); } catch (e) { return []; }
}
function saveAllBookmarks(list) {
  try { localStorage.setItem(BOOKMARK_KEY, JSON.stringify(list)); } catch (e) { /* ignore */ }
}

function saveBookmark() {
  if (!state.chunks.length || !state.fileKey) {
    alert("ファイルが読み込まれていません。"); return;
  }
  const label = prompt(
    "しおりの名前を入力してください（空白のままでもOKです）:",
    `${state.fileName} — ${state.index + 1}/${state.chunks.length}章`
  );
  if (label === null) return; // キャンセル

  const bm = {
    id: Date.now(),
    label: label.trim() || `${state.fileName} — ${state.index + 1}/${state.chunks.length}章`,
    fileKey: state.fileKey,
    fileName: state.fileName,
    index: state.index,
    total: state.chunks.length,
    date: new Date().toLocaleString("ja-JP", { year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit" }),
  };
  const list = loadAllBookmarks();
  list.unshift(bm);
  saveAllBookmarks(list);
  buildBookmarkList();
}

function deleteBookmark(id) {
  const list = loadAllBookmarks().filter(b => b.id !== id);
  saveAllBookmarks(list);
  buildBookmarkList();
}

function buildBookmarkList() {
  const list = loadAllBookmarks();
  els.bookmarkBody.innerHTML = "";
  if (!list.length) {
    els.bookmarkBody.innerHTML = '<p style="padding:16px;color:var(--text-dim);font-size:13px;">保存されたしおりはありません。<br>「現在位置を保存」で追加できます。</p>';
    return;
  }
  const frag = document.createDocumentFragment();
  for (const bm of list) {
    const item = document.createElement("div");
    item.className = "bookmark-item";

    const info = document.createElement("div");
    info.className = "bookmark-info";
    const title = document.createElement("div");
    title.className = "bookmark-title";
    title.textContent = bm.label;
    const meta = document.createElement("div");
    meta.className = "bookmark-meta";
    meta.textContent = `${bm.date}　${bm.index + 1}/${bm.total}章`;
    info.appendChild(title); info.appendChild(meta);

    const actions = document.createElement("div");
    actions.className = "bookmark-actions";

    // lastModifiedを除いたfilename:sizeで比較することで
    // デバイス間でインポートしたしおりでもジャンプ可能にする
    if (fileKeyBase(bm.fileKey) === fileKeyBase(state.fileKey)) {
      const jumpBtn = document.createElement("button");
      jumpBtn.textContent = "ジャンプ";
      jumpBtn.addEventListener("click", () => {
        jumpToChunk(bm.index);
        closeModal(els.bookmarkOverlay);
      });
      actions.appendChild(jumpBtn);
    } else {
      const note = document.createElement("span");
      note.style.cssText = "font-size:11px;color:var(--text-dim);white-space:nowrap;";
      note.textContent = bm.fileName;
      actions.appendChild(note);
    }

    const delBtn = document.createElement("button");
    delBtn.textContent = "削除";
    delBtn.style.background = "none";
    delBtn.addEventListener("click", () => {
      if (confirm(`「${bm.label}」を削除しますか？`)) deleteBookmark(bm.id);
    });
    actions.appendChild(delBtn);

    item.appendChild(info); item.appendChild(actions);
    frag.appendChild(item);
  }
  els.bookmarkBody.appendChild(frag);
}

function exportBookmarks() {
  const list = loadAllBookmarks();
  if (!list.length) { alert("保存されたしおりがありません。"); return; }
  const json = JSON.stringify(list);
  navigator.clipboard.writeText(json).then(() => {
    alert("しおりデータをクリップボードにコピーしました。\nメモ帳やGoogleドキュメント等に貼り付けて保存してください。\n別の端末でインポートする際は、その文字列を「インポート」から貼り付けてください。");
  }).catch(() => {
    // クリップボードAPIが使えない場合 (iOS Safariなど) はテキストエリアで表示
    const ta = document.createElement("textarea");
    ta.value = json;
    ta.style.cssText = "position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);width:90vw;height:40vh;z-index:9999;background:#1e212b;color:#f1eee6;border:1px solid #343a4a;border-radius:8px;padding:10px;font-size:12px;";
    document.body.appendChild(ta);
    ta.select();
    alert("以下のテキストをすべて選択してコピーしてください。コピー後、このダイアログを閉じると消えます。");
    document.body.removeChild(ta);
  });
}

function importBookmarks() {
  const json = prompt("エクスポートしたしおりデータを貼り付けてください:");
  if (!json) return;
  try {
    const incoming = JSON.parse(json.trim());
    if (!Array.isArray(incoming)) throw new Error("配列ではありません");
    const existing = loadAllBookmarks();
    const existIds = new Set(existing.map(b => b.id));
    const merged = [...existing, ...incoming.filter(b => !existIds.has(b.id))];
    saveAllBookmarks(merged);
    buildBookmarkList();
    alert(`${incoming.length}件のしおりをインポートしました（重複は除外）。`);
  } catch (e) {
    alert("インポートに失敗しました。正しいしおりデータを貼り付けてください。");
  }
}

/* ---- モーダル開閉 ---- */
function openModal(overlay, onOpen) {
  overlay.classList.remove("hidden");
  document.body.style.overflow = "hidden";
  if (onOpen) onOpen();
}
function closeModal(overlay) {
  overlay.classList.add("hidden");
  document.body.style.overflow = "";
}

/* ---- ファイル読み込み ---- */
function decodeFileBuffer(buffer) {
  try {
    const utf8 = new TextDecoder("utf-8", { fatal: true });
    let text = utf8.decode(buffer);
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return { text, encoding: "UTF-8" };
  } catch (e) {
    const sjis = new TextDecoder("shift_jis");
    const text = sjis.decode(buffer);
    return { text, encoding: "Shift_JIS" };
  }
}

async function loadText(rawText, fileKey, fileName) {
  els.dropHint.style.display = "none";

  // 行末を統一する (CRLFやCR → LF)
  const text = rawText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  if (!state.dictReady) {
    state.pendingLoad = { text, fileKey, fileName };
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
  state.fileName = fileName;
  state.originalText = text;
  state.paused = true;
  state.searchMatches = [];
  state.searchMatchIdx = -1;

  // 見出し抽出
  const rawHeadings = extractHeadings(text);
  state.headings = rawHeadings.map(h => ({
    ...h,
    chunkIndex: charOffsetToChunkIdx(h.charOffset),
  }));

  const saved = loadProgress(fileKey);
  const total = chunks.length;
  if (typeof saved === "number" && saved > 0 && saved < total - 1) {
    const resume = window.confirm(
      `前回の続き (${saved + 1} / ${total}) から再生しますか？\n「キャンセル」で最初から再生します。`
    );
    state.index = resume ? saved : 0;
  } else {
    state.index = 0;
  }

  resizeCanvas();
  render();
}

els.retryDictBtn.addEventListener("click", () => { location.reload(); });

function fileKeyFor(file) { return `${file.name}:${file.size}:${file.lastModified || 0}`; }

els.fileInput.addEventListener("change", (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    let decoded;
    try { decoded = decodeFileBuffer(reader.result); } catch (err) {
      els.statusText.textContent = "文字コードを判別できず、読み込めませんでした。"; return;
    }
    if (decoded.encoding === "Shift_JIS") {
      els.statusText.textContent = "Shift_JISとして読み込みました。解析中...";
    }
    loadText(decoded.text, fileKeyFor(file), file.name);
  };
  reader.onerror = () => { els.statusText.textContent = "ファイルを読み込めませんでした。"; };
  reader.readAsArrayBuffer(file);
  els.fileInput.value = "";
});

els.openFileBtn.addEventListener("click", () => els.fileInput.click());

/* ---- 設定パネル ---- */
els.gearBtn.addEventListener("click", () => { els.settingsPanel.classList.toggle("open"); });
els.fontFamily.addEventListener("change", () => {
  els.fontFamilyCustom.style.display = els.fontFamily.value === "__custom__" ? "block" : "none";
});
els.fontSize.addEventListener("input", () => { els.fontSizeLabel.textContent = `${els.fontSize.value}px`; });
els.confirmFontBtn.addEventListener("click", () => {
  state.fontFamily = els.fontFamily.value === "__custom__"
    ? (els.fontFamilyCustom.value.trim() || state.fontFamily)
    : els.fontFamily.value;
  state.fontSize = parseInt(els.fontSize.value, 10);
  state.monoColor = els.colorMode.value === "mono";
  try {
    localStorage.setItem("jrsvp_font_family", state.fontFamily);
    localStorage.setItem("jrsvp_font_size", String(state.fontSize));
    localStorage.setItem("jrsvp_mono_color", state.monoColor ? "1" : "0");
  } catch (e) { /* ignore */ }
  render();
  els.settingsPanel.classList.remove("open");
  els.confirmFontBtn.blur();
});
els.jumpBtn.addEventListener("click", () => { jumpToInput(); els.jumpBtn.blur(); });
els.jumpInput.addEventListener("keydown", (e) => { if (e.key === "Enter") jumpToInput(); });

/* ---- 目次 ---- */
els.tocBtn.addEventListener("click", () => { openModal(els.tocOverlay, buildTOC); });
els.tocCloseBtn.addEventListener("click", () => closeModal(els.tocOverlay));
els.tocOverlay.addEventListener("click", (e) => { if (e.target === els.tocOverlay) closeModal(els.tocOverlay); });

/* ---- 検索 ---- */
els.searchBtn.addEventListener("click", () => {
  const isOpen = els.searchPanel.classList.contains("open");
  if (isOpen) {
    els.searchPanel.classList.remove("open");
    state.searchMatches = []; els.searchCount.textContent = "";
  } else {
    els.searchPanel.classList.add("open");
    els.searchInput.focus();
  }
  els.settingsPanel.classList.remove("open");
});
els.searchCloseBtn.addEventListener("click", () => {
  els.searchPanel.classList.remove("open");
  state.searchMatches = []; els.searchCount.textContent = "";
});
els.searchInput.addEventListener("keydown", (e) => { if (e.key === "Enter") doSearch(); });
els.searchInput.addEventListener("input", () => {
  // 入力が変わったらマッチをリセット
  state.searchMatches = []; state.searchMatchIdx = -1; els.searchCount.textContent = "";
});
els.searchNextBtn.addEventListener("click", () => {
  if (state.searchMatches.length) searchGo(1); else doSearch();
});
els.searchPrevBtn.addEventListener("click", () => searchGo(-1));

/* ---- しおり ---- */
els.bookmarkBtn.addEventListener("click", () => { openModal(els.bookmarkOverlay, buildBookmarkList); });
els.bookmarkCloseBtn.addEventListener("click", () => closeModal(els.bookmarkOverlay));
els.bookmarkOverlay.addEventListener("click", (e) => { if (e.target === els.bookmarkOverlay) closeModal(els.bookmarkOverlay); });
els.saveBookmarkBtn.addEventListener("click", saveBookmark);
els.exportBookmarkBtn.addEventListener("click", exportBookmarks);
els.importBookmarkBtn.addEventListener("click", importBookmarks);

/* ---- トランスポート ---- */
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
    case " ": e.preventDefault(); togglePause(); break;
    case "ArrowLeft": e.preventDefault(); seek(-1); break;
    case "ArrowRight": e.preventDefault(); seek(1); break;
    case "ArrowUp": e.preventDefault(); changeSpeed(20); break;
    case "ArrowDown": e.preventDefault(); changeSpeed(-20); break;
    case "f": case "F": els.searchPanel.classList.toggle("open"); if (els.searchPanel.classList.contains("open")) els.searchInput.focus(); break;
  }
});

/* ---- 初期化 ---- */
els.colorMode.value = state.monoColor ? "mono" : "red";

// 保存されたフォント設定をUIに反映する
{
  const savedFamily = localStorage.getItem("jrsvp_font_family");
  if (savedFamily) {
    // セレクトボックスの選択肢に一致するものがあれば選択、なければカスタム扱い
    let found = false;
    for (const opt of els.fontFamily.options) {
      if (opt.value === savedFamily) { els.fontFamily.value = savedFamily; found = true; break; }
    }
    if (!found && savedFamily !== "__custom__") {
      els.fontFamily.value = "__custom__";
      els.fontFamilyCustom.value = savedFamily;
      els.fontFamilyCustom.style.display = "block";
    }
  }
  const savedSize = localStorage.getItem("jrsvp_font_size");
  if (savedSize) {
    els.fontSize.value = savedSize;
    els.fontSizeLabel.textContent = `${savedSize}px`;
  }
}
resizeCanvas();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

els.statusText.textContent = "辞書を準備中です...";
dictWorker.postMessage({ type: "init" });
