// LocalLLM Studio — browser-based client for local LLM servers (Ollama / OpenAI-compatible).
// No build step: plain ES module. State persists in localStorage.

import { listModels, streamChat, generateImage } from "./providers.js";
import {
  storeImages,
  deleteStoredImages,
  renderImageGallery,
  extractMarkdownImages,
} from "./images.js";
import { DEFAULT_SERVER } from "./config.js";

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */
const STORAGE_KEY = "localllm-studio.v1";

const defaultState = () => ({
  providers: [
    {
      id: crypto.randomUUID(),
      name: DEFAULT_SERVER.name,
      type: DEFAULT_SERVER.type,
      baseUrl: DEFAULT_SERVER.baseUrl,
      apiKey: "",
    },
  ],
  settings: {
    systemPrompt: "",
    temperature: 0.7,
    maxTokens: null,
  },
  conversations: [],
  activeConversationId: null,
  // last-used selection
  selectedProviderId: null,
  selectedModel: null,
});

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    // shallow-merge with defaults to tolerate older saved data
    return { ...defaultState(), ...parsed };
  } catch {
    return defaultState();
  }
}

let state = loadState();

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (err) {
    console.error(err);
    if (els?.composerHint) {
      els.composerHint.textContent =
        "⚠️ ブラウザの保存容量が一杯のため会話を保存できませんでした。古い会話を削除してください。";
    }
  }
}

/* ------------------------------------------------------------------ *
 * DOM refs
 * ------------------------------------------------------------------ */
const $ = (sel) => document.querySelector(sel);

const els = {
  main: $("#main"),
  chatUsage: $("#chat-usage"),
  thinkToggle: $("#think-toggle"),
  imageToggle: $("#image-toggle"),
  jumpLatest: $("#jump-latest"),
  conversationList: $("#conversation-list"),
  newChat: $("#new-chat"),
  messages: $("#messages"),
  chatTitle: $("#chat-title"),
  providerSelect: $("#provider-select"),
  modelSelect: $("#model-select"),
  refreshModels: $("#refresh-models"),
  connectionStatus: $("#connection-status"),
  promptInput: $("#prompt-input"),
  sendBtn: $("#send-btn"),
  stopBtn: $("#stop-btn"),
  composerHint: $("#composer-hint"),
  // settings
  openSettings: $("#open-settings"),
  closeSettings: $("#close-settings"),
  settingsModal: $("#settings-modal"),
  providersEditor: $("#providers-editor"),
  addProvider: $("#add-provider"),
  systemPrompt: $("#system-prompt"),
  temperature: $("#temperature"),
  tempValue: $("#temp-value"),
  maxTokens: $("#max-tokens"),
  saveSettings: $("#save-settings"),
};

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */
function activeConversation() {
  return state.conversations.find((c) => c.id === state.activeConversationId) || null;
}

function currentProvider() {
  return (
    state.providers.find((p) => p.id === state.selectedProviderId) ||
    state.providers[0] ||
    null
  );
}

function renderMarkdown(text) {
  const html = window.marked.parse(text, { breaks: true, gfm: true });
  return window.DOMPurify.sanitize(html);
}

/* ------------------------------------------------------------------ *
 * HTML preview — renders ```html code blocks in a sandboxed iframe.
 * sandbox without allow-same-origin gives the page an opaque origin,
 * so generated code cannot read this app's localStorage (API key).
 * ------------------------------------------------------------------ */
const PREVIEW_SANDBOX = "allow-scripts allow-forms allow-modals";

function isHtmlBlock(codeEl) {
  if (/\blanguage-(html|htm|xhtml)\b/i.test(codeEl.className)) return true;
  return /^\s*(<!doctype html|<html[\s>])/i.test(codeEl.textContent);
}

function createPreviewFrame(html) {
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", PREVIEW_SANDBOX);
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.srcdoc = html;
  return frame;
}

function attachHtmlPreviews(contentEl) {
  contentEl.querySelectorAll("pre > code").forEach((codeEl) => {
    const pre = codeEl.parentElement;
    if (pre.dataset.previewReady || !isHtmlBlock(codeEl)) return;
    pre.dataset.previewReady = "1";

    const bar = document.createElement("div");
    bar.className = "html-preview-bar";
    bar.innerHTML = `
      <span class="html-preview-label">HTML</span>
      <button type="button" data-act="toggle">▶ プレビュー</button>
      <button type="button" data-act="full">⛶ 全画面</button>`;
    pre.before(bar);

    let panel = null;
    bar.querySelector('[data-act="toggle"]').addEventListener("click", (e) => {
      if (panel) {
        panel.remove();
        panel = null;
        pre.hidden = false;
        e.target.textContent = "▶ プレビュー";
        return;
      }
      panel = document.createElement("div");
      panel.className = "html-preview-panel";
      panel.appendChild(createPreviewFrame(codeEl.textContent));
      pre.after(panel);
      pre.hidden = true;
      e.target.textContent = "</> コード";
    });
    bar.querySelector('[data-act="full"]').addEventListener("click", () => {
      openFullPreview(codeEl.textContent);
    });
  });
}

function openFullPreview(html) {
  const overlay = document.createElement("div");
  overlay.className = "html-preview-overlay";
  const head = document.createElement("div");
  head.className = "html-preview-overlay-head";
  head.innerHTML = `<span>HTMLプレビュー</span><button type="button" class="btn-icon">✕</button>`;
  overlay.appendChild(head);
  overlay.appendChild(createPreviewFrame(html));
  document.body.appendChild(overlay);

  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e) => {
    if (e.key === "Escape") close();
  };
  head.querySelector("button").addEventListener("click", close);
  document.addEventListener("keydown", onKey);
}

/* ------------------------------------------------------------------ *
 * Usage & timing
 * Token counts come from the server when it reports them; otherwise
 * they are estimated from character counts (≈4 ASCII chars or ≈1
 * Japanese char per token) and marked with "~".
 * ------------------------------------------------------------------ */
function estimateTokens(text) {
  if (!text) return 0;
  let ascii = 0;
  let other = 0;
  for (const ch of text) {
    if (ch.charCodeAt(0) < 128) ascii++;
    else other++;
  }
  return Math.ceil(ascii / 4 + other);
}

function estimateMessagesTokens(messages) {
  // ~4 tokens of chat-template overhead per message, ~3 to prime the reply
  return messages.reduce((n, m) => n + estimateTokens(m.content) + 4, 3);
}

// Separates inline <think>…</think> reasoning (DeepSeek-R1, Qwen3, …)
// from the answer. Some templates pre-fill "<think>", so the stream may
// contain only the closing tag.
function splitThink(raw) {
  const open = raw.search(/<think>/i);
  const close = raw.search(/<\/think>/i);
  if (open !== -1 && (close === -1 || open < close) && !raw.slice(0, open).trim()) {
    const rest = raw.slice(open + "<think>".length);
    const end = rest.search(/<\/think>/i);
    if (end === -1) return { reasoning: rest, answer: "" };
    return {
      reasoning: rest.slice(0, end),
      answer: rest.slice(end + "</think>".length).trimStart(),
    };
  }
  if (close !== -1 && open === -1) {
    return {
      reasoning: raw.slice(0, close),
      answer: raw.slice(close + "</think>".length).trimStart(),
    };
  }
  return { reasoning: "", answer: raw };
}

function fmtSec(ms) {
  const s = ms / 1000;
  if (s < 10) return s.toFixed(1) + "秒";
  if (s < 60) return Math.round(s) + "秒";
  return `${Math.floor(s / 60)}分${Math.round(s % 60)}秒`;
}

function fmtNum(n) {
  return Math.round(n).toLocaleString("ja-JP");
}

function formatStats(s) {
  if (s.kind === "image") return `🎨 画像生成 ${fmtSec(s.totalMs)} · ${s.count}枚`;
  const t = s.estimated ? "~" : "";
  const parts = [
    s.reasoned === false ? `⏳ 応答開始 ${fmtSec(s.thinkMs)}` : `💭 思考 ${fmtSec(s.thinkMs)}`,
    `⏱ 合計 ${fmtSec(s.totalMs)}`,
    `入力 ${t}${fmtNum(s.inputTokens)} / 出力 ${t}${fmtNum(s.outputTokens)} tok` +
      (s.estimated ? "（推定）" : ""),
  ];
  if (s.tps) parts.push(`${s.tps.toFixed(1)} tok/s`);
  return parts.join(" · ");
}

const STATS_TOOLTIP =
  "思考: 送信から回答が始まるまで（推論モデルの思考時間を含む）\n" +
  "応答開始: 思考なしの場合の、送信から回答が始まるまでの時間\n" +
  "合計: 送信から完了まで\n" +
  "入力/出力: トークン数。「~」はサーバーが実数を返さなかったため文字数から推定した値\n" +
  "tok/s: 出力の生成速度";

function setStatsLine(msgEl, text, live = false) {
  let el = msgEl.querySelector(".msg-stats");
  if (!el) {
    el = document.createElement("div");
    el.className = "msg-stats";
    el.title = STATS_TOOLTIP;
    msgEl.querySelector(".body").appendChild(el);
  }
  el.textContent = text;
  el.classList.toggle("live", live);
}

function setReasoning(msgEl, text, { live = false, thinkMs = null } = {}) {
  let el = msgEl.querySelector(".reasoning");
  if (!text) {
    if (el) el.remove();
    return;
  }
  if (!el) {
    el = document.createElement("details");
    el.className = "reasoning";
    el.innerHTML = `<summary></summary><div class="reasoning-body"></div>`;
    msgEl.querySelector(".body").insertBefore(el, msgEl.querySelector(".content"));
    // opened while thinking → jump to the newest thoughts
    el.addEventListener("toggle", () => {
      const b = el.querySelector(".reasoning-body");
      if (el.open && el.dataset.live) b.scrollTop = b.scrollHeight;
    });
  }
  el.dataset.live = live ? "1" : "";
  el.querySelector("summary").textContent = live
    ? "💭 思考中…"
    : thinkMs != null
      ? `💭 思考過程（${fmtSec(thinkMs)}）`
      : "💭 思考過程";
  const body = el.querySelector(".reasoning-body");
  const follow = isNearBottom(body, 24);
  body.textContent = text.trim();
  if (follow) body.scrollTop = body.scrollHeight;
}

function renderConversationUsage() {
  const conv = activeConversation();
  let total = 0;
  let estimated = false;
  for (const m of conv?.messages || []) {
    if (!m.stats || m.stats.kind === "image") continue;
    total += m.stats.inputTokens + m.stats.outputTokens;
    estimated ||= m.stats.estimated;
  }
  els.chatUsage.textContent = total ? `累計 ${estimated ? "~" : ""}${fmtNum(total)} tok` : "";
  els.chatUsage.title = "この会話で使ったトークン数の合計（各リクエストの入力+出力）";
}

// Follow new output only while the user is at the bottom, so they can
// scroll up and read during streaming.
let stickToBottom = true;

function isNearBottom(el, margin) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < margin;
}

function scrollToBottom(force = false) {
  if (force) stickToBottom = true;
  if (stickToBottom) els.messages.scrollTop = els.messages.scrollHeight;
  updateJumpButton();
}

function updateJumpButton() {
  els.jumpLatest.hidden = stickToBottom || isNearBottom(els.messages, 60);
}

/* ------------------------------------------------------------------ *
 * Conversation list
 * ------------------------------------------------------------------ */
function renderConversationList() {
  els.conversationList.innerHTML = "";
  if (state.conversations.length === 0) {
    const empty = document.createElement("div");
    empty.className = "hint";
    empty.style.padding = "8px 10px";
    empty.textContent = "会話はまだありません";
    els.conversationList.appendChild(empty);
    return;
  }
  for (const conv of state.conversations) {
    const item = document.createElement("div");
    item.className = "conv-item" + (conv.id === state.activeConversationId ? " active" : "");

    const name = document.createElement("span");
    name.className = "conv-name";
    name.textContent = conv.title || "新しいチャット";
    name.title = "ダブルクリックで名前を変更";
    name.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      startRename(conv, item, name);
    });
    item.appendChild(name);

    const edit = document.createElement("button");
    edit.className = "conv-edit";
    edit.textContent = "✎";
    edit.title = "名前を変更";
    edit.addEventListener("click", (e) => {
      e.stopPropagation();
      startRename(conv, item, name);
    });
    item.appendChild(edit);

    const del = document.createElement("button");
    del.className = "conv-del";
    del.textContent = "🗑";
    del.title = "削除";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteConversation(conv.id);
    });
    item.appendChild(del);

    item.addEventListener("click", () => selectConversation(conv.id));
    els.conversationList.appendChild(item);
  }
}

function startRename(conv, item, nameEl) {
  if (item.querySelector(".conv-rename-input")) return; // already editing
  const input = document.createElement("input");
  input.className = "conv-rename-input";
  input.value = conv.title || "";
  nameEl.replaceWith(input);
  input.focus();
  input.select();

  const commit = (saveIt) => {
    if (saveIt) {
      const val = input.value.trim();
      conv.title = val || "新しいチャット";
      save();
    }
    renderConversationList();
    renderMessages();
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") commit(true);
    else if (e.key === "Escape") commit(false);
  });
  input.addEventListener("blur", () => commit(true));
  input.addEventListener("click", (e) => e.stopPropagation());
}

function newConversation() {
  const conv = {
    id: crypto.randomUUID(),
    title: "新しいチャット",
    messages: [],
    createdAt: Date.now(),
  };
  state.conversations.unshift(conv);
  state.activeConversationId = conv.id;
  save();
  renderConversationList();
  renderMessages();
  els.promptInput.focus();
}

function selectConversation(id) {
  state.activeConversationId = id;
  save();
  renderConversationList();
  renderMessages();
}

function deleteConversation(id) {
  const conv = state.conversations.find((c) => c.id === id);
  deleteStoredImages((conv?.messages || []).flatMap((m) => m.images || []));
  state.conversations = state.conversations.filter((c) => c.id !== id);
  if (state.activeConversationId === id) {
    state.activeConversationId = state.conversations[0]?.id || null;
  }
  save();
  renderConversationList();
  renderMessages();
}

/* ------------------------------------------------------------------ *
 * Messages
 * ------------------------------------------------------------------ */
function renderMessages() {
  const conv = activeConversation();
  els.messages.innerHTML = "";
  els.chatTitle.textContent = conv?.title || "新しいチャット";
  renderConversationUsage();

  if (!conv || conv.messages.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML = `
      <div class="big"><img src="icon.svg" alt="" width="72" height="72" /></div>
      <div><strong>LocalLLM Studio</strong></div>
      <div>ローカルで動作するLLMとチャットしましょう。<br/>
      右上でプロバイダとモデルを選び、メッセージを送信してください。</div>`;
    els.messages.appendChild(empty);
    return;
  }

  for (const msg of conv.messages) {
    els.messages.appendChild(buildMessageEl(msg));
  }
  scrollToBottom(true);
}

function buildMessageEl(msg) {
  const { role, content } = msg;
  const wrap = document.createElement("div");
  wrap.className = `msg ${role}`;

  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = role === "user" ? "You" : "AI";
  avatar.style.fontSize = "11px";

  const body = document.createElement("div");
  body.className = "body";

  const roleName = document.createElement("div");
  roleName.className = "role-name";
  roleName.textContent = role === "user" ? "あなた" : "アシスタント";

  const contentEl = document.createElement("div");
  contentEl.className = "content";
  contentEl.innerHTML = role === "user"
    ? renderMarkdown(content)
    : renderMarkdown(content || "");
  if (role === "assistant") attachHtmlPreviews(contentEl);

  body.appendChild(roleName);
  body.appendChild(contentEl);
  wrap.appendChild(avatar);
  wrap.appendChild(body);
  if (role === "assistant") {
    setReasoning(wrap, msg.reasoning, { thinkMs: msg.stats?.thinkMs });
    if (msg.images?.length) renderImageGallery(wrap, msg.images);
    if (msg.stats) setStatsLine(wrap, formatStats(msg.stats));
  }
  return wrap;
}

/* ------------------------------------------------------------------ *
 * Provider / model selectors
 * ------------------------------------------------------------------ */
function renderProviderSelect() {
  els.providerSelect.innerHTML = "";
  for (const p of state.providers) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.name;
    els.providerSelect.appendChild(opt);
  }
  if (!currentProvider() && state.providers[0]) {
    state.selectedProviderId = state.providers[0].id;
  }
  if (currentProvider()) els.providerSelect.value = currentProvider().id;
}

async function refreshModels() {
  const provider = currentProvider();
  els.modelSelect.innerHTML = "";
  renderApiKeyBanner();
  if (!provider) {
    setStatus("unknown");
    return;
  }
  if (DEFAULT_SERVER.requireApiKey && !provider.apiKey) {
    setStatus("unknown");
    els.composerHint.textContent = "上部で API キーを入力すると接続できます。";
    return;
  }
  setStatus("unknown");
  els.composerHint.textContent = `${provider.name} からモデル一覧を取得中…`;
  try {
    const models = await listModels(provider);
    els.modelSelect.innerHTML = "";
    if (models.length === 0) {
      const opt = document.createElement("option");
      opt.textContent = "(モデルなし)";
      opt.value = "";
      els.modelSelect.appendChild(opt);
    }
    for (const m of models) {
      const opt = document.createElement("option");
      opt.value = m;
      opt.textContent = m;
      els.modelSelect.appendChild(opt);
    }
    // restore previous selection if still present
    if (state.selectedModel && models.includes(state.selectedModel)) {
      els.modelSelect.value = state.selectedModel;
    } else {
      state.selectedModel = models[0] || null;
    }
    renderModeToggles();
    setStatus("ok");
    els.composerHint.textContent = `${models.length} 個のモデルを検出しました。`;
    save();
  } catch (err) {
    setStatus("error");
    els.composerHint.textContent =
      `接続に失敗しました (${provider.baseUrl})。サーバーが起動しているか、CORS設定を確認してください。`;
    const opt = document.createElement("option");
    opt.textContent = "(接続失敗)";
    opt.value = "";
    els.modelSelect.appendChild(opt);
    console.error(err);
  }
}

function setStatus(kind) {
  els.connectionStatus.className = "status-dot status-" + kind;
}

/* ------------------------------------------------------------------ *
 * API key banner — shown when the server needs a key and none is set.
 * The key is saved only in the user's own browser (localStorage).
 * ------------------------------------------------------------------ */
function renderApiKeyBanner() {
  const existing = document.getElementById("api-key-banner");
  const provider = currentProvider();
  const needsKey = DEFAULT_SERVER.requireApiKey && provider && !provider.apiKey;

  if (!needsKey) {
    if (existing) existing.remove();
    return;
  }
  if (existing) return; // already shown

  const bar = document.createElement("div");
  bar.id = "api-key-banner";
  bar.className = "api-key-banner";
  bar.innerHTML = `
    <span>🔑 このサーバーを使うには API キーが必要です（あなたのブラウザにのみ保存されます）</span>
    <input type="password" id="inline-api-key" placeholder="API キーを貼り付け" />
    <button id="inline-api-key-save" class="btn-primary">保存して接続</button>
  `;
  els.main.insertBefore(bar, els.messages);

  const input = bar.querySelector("#inline-api-key");
  const saveKey = () => {
    const val = input.value.trim();
    if (!val) return;
    provider.apiKey = val;
    save();
    bar.remove();
    refreshModels();
  };
  bar.querySelector("#inline-api-key-save").addEventListener("click", saveKey);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") saveKey();
  });
}

/* ------------------------------------------------------------------ *
 * Sending / streaming
 * ------------------------------------------------------------------ */
let abortController = null;

function renderThinkToggle() {
  const on = state.settings.thinking !== false;
  // label text hides on narrow screens, leaving the icon
  els.thinkToggle.innerHTML = on
    ? `💭<span class="btn-label"> 思考あり</span>`
    : `⚡<span class="btn-label"> 思考なし</span>`;
  els.thinkToggle.setAttribute("aria-label", on ? "思考あり" : "思考なし");
  els.thinkToggle.classList.toggle("off", !on);
  els.thinkToggle.setAttribute("aria-pressed", String(on));
  els.thinkToggle.title = on
    ? "推論モデルに考えさせてから回答させます（クリックで思考なしに切替）"
    : "思考を省いてすぐ回答させます（クリックで思考ありに切替）";
}

function setStreaming(on) {
  els.sendBtn.disabled = on;
  els.stopBtn.hidden = !on;
  els.promptInput.disabled = on;
}

async function sendMessage() {
  const text = els.promptInput.value.trim();
  if (!text) return;

  const provider = currentProvider();
  const model = els.modelSelect.value;
  if (!provider) {
    els.composerHint.textContent = "プロバイダが設定されていません。設定から追加してください。";
    return;
  }
  if (!model) {
    els.composerHint.textContent = "モデルが選択されていません。⟳ で一覧を更新してください。";
    return;
  }

  // ensure a conversation exists
  let conv = activeConversation();
  if (!conv) {
    newConversation();
    conv = activeConversation();
  }

  // append user message
  conv.messages.push({ role: "user", content: text });
  if (conv.messages.length === 1) {
    conv.title = text.slice(0, 40);
  }
  els.promptInput.value = "";
  autoResize();
  state.selectedModel = model;
  save();
  renderConversationList();
  renderMessages();

  // build placeholder assistant message
  const assistantMsg = { role: "assistant", content: "" };
  conv.messages.push(assistantMsg);
  const msgEl = buildMessageEl(assistantMsg);
  const contentEl = msgEl.querySelector(".content");
  contentEl.classList.add("cursor-blink");
  els.messages.appendChild(msgEl);
  scrollToBottom(true);

  // assemble request messages (with system prompt).
  // Reasoning is kept out of the history, only the answer is sent back.
  const reqMessages = [];
  if (state.settings.systemPrompt?.trim()) {
    reqMessages.push({ role: "system", content: state.settings.systemPrompt.trim() });
  }
  for (const m of conv.messages) {
    if (m === assistantMsg) continue; // skip the empty placeholder
    // images stay out of the history; an image-only reply becomes "[画像]"
    reqMessages.push({ role: m.role, content: m.content || (m.images?.length ? "[画像]" : "") });
  }

  abortController = new AbortController();
  setStreaming(true);

  if (isImageMode(model)) {
    await runImageGeneration({ provider, model, prompt: text, assistantMsg, msgEl, contentEl });
    return;
  }

  const t0 = performance.now();
  let firstTokenAt = null; // first output of any kind (reasoning or answer)
  let firstAnswerAt = null; // answer text begins → thinking is over
  let raw = ""; // answer stream, may contain inline <think> tags
  let fieldReasoning = ""; // reasoning sent in a separate field
  let usage = null;
  let notice = "";
  const thinkingOn = state.settings.thinking !== false;
  const fieldImages = []; // images sent as content parts / `images` field
  let galleryKey = "";

  const currentReasoning = () => fieldReasoning + splitThink(raw).reasoning;
  // markdown ![](…) images are pulled out of the text into the gallery
  const currentAnswer = () => extractMarkdownImages(splitThink(raw).answer);

  const update = () => {
    const now = performance.now();
    firstTokenAt ??= now;
    const { answer } = splitThink(raw);
    if (!firstAnswerAt && (answer.trim() || fieldImages.length)) firstAnswerAt = now;
    const md = extractMarkdownImages(answer);
    assistantMsg.content = md.text;
    setReasoning(msgEl, currentReasoning(), {
      live: !firstAnswerAt,
      thinkMs: firstAnswerAt && firstAnswerAt - t0,
    });
    contentEl.innerHTML = renderMarkdown(md.text);
    contentEl.classList.add("cursor-blink");
    // re-render the gallery only when an image completes or starts arriving
    const srcs = [...fieldImages, ...md.srcs];
    const key = `${srcs.length}|${md.pending}`;
    if (key !== galleryKey) {
      galleryKey = key;
      renderImageGallery(msgEl, srcs.map((url) => ({ url })), { pending: md.pending });
    }
    scrollToBottom();
  };

  const tick = () => {
    const elapsed = performance.now() - t0;
    const reasoned = !!currentReasoning();
    if (!firstAnswerAt) {
      const label = thinkingOn || reasoned ? "💭 思考中…" : "⏳ 応答待ち…";
      setStatsLine(msgEl, `${label} ${fmtSec(elapsed)}`, true);
    } else {
      const out = estimateTokens(currentReasoning() + assistantMsg.content);
      const first = reasoned ? "💭 思考" : "⏳ 応答開始";
      setStatsLine(
        msgEl,
        `${first} ${fmtSec(firstAnswerAt - t0)} · ⏱ 生成中… ${fmtSec(elapsed)} · 出力 ~${fmtNum(out)} tok`,
        true
      );
    }
  };
  tick();
  const timer = setInterval(tick, 100);

  let aborted = false;
  let error = null;
  try {
    await streamChat({
      provider,
      model,
      messages: reqMessages,
      options: {
        temperature: state.settings.temperature,
        maxTokens: state.settings.maxTokens,
        thinking: thinkingOn,
      },
      signal: abortController.signal,
      onToken: (chunk) => {
        raw += chunk;
        update();
      },
      onReasoning: (chunk) => {
        fieldReasoning += chunk;
        update();
      },
      onImage: (src) => {
        fieldImages.push(src);
        update();
      },
      onUsage: (u) => {
        usage = u;
      },
      onNotice: (msg) => {
        notice = msg;
      },
    });
    if (!thinkingOn && currentReasoning()) {
      notice = "このモデル/サーバーは思考オフに対応していないため、思考ありで生成されました。";
    }
    els.composerHint.textContent = notice;
  } catch (err) {
    if (err.name === "AbortError") aborted = true;
    else error = err;
  }

  clearInterval(timer);
  const end = performance.now();
  const reasoning = currentReasoning();
  assistantMsg.reasoning = reasoning || undefined;
  const imageSrcs = [...fieldImages, ...currentAnswer().srcs];
  if (imageSrcs.length) assistantMsg.images = await storeImages(imageSrcs);

  if (error) {
    console.error(error);
    assistantMsg.content += (assistantMsg.content ? "\n\n" : "") + `⚠️ エラー: ${error.message}`;
    msgEl.querySelector(".msg-stats")?.remove();
  } else {
    const outputTokens = usage?.output ?? estimateTokens(reasoning + assistantMsg.content);
    const genMs = firstTokenAt ? end - firstTokenAt : 0;
    assistantMsg.stats = {
      thinkMs: (firstAnswerAt ?? end) - t0,
      totalMs: end - t0,
      inputTokens: usage?.input ?? estimateMessagesTokens(reqMessages),
      outputTokens,
      estimated: !usage,
      reasoned: !!reasoning,
      tps: genMs > 200 ? outputTokens / (genMs / 1000) : null,
    };
    setStatsLine(msgEl, formatStats(assistantMsg.stats));
    if (aborted) assistantMsg.content += "\n\n*（停止しました）*";
  }

  setReasoning(msgEl, reasoning, { thinkMs: (firstAnswerAt ?? end) - t0 });
  contentEl.innerHTML = renderMarkdown(assistantMsg.content);
  contentEl.classList.remove("cursor-blink");
  renderImageGallery(msgEl, assistantMsg.images || []);
  attachHtmlPreviews(contentEl);
  renderConversationUsage();
  setStreaming(false);
  abortController = null;
  save();
}

// Image-generation mode: send the prompt to /images/generations.
async function runImageGeneration({ provider, model, prompt, assistantMsg, msgEl, contentEl }) {
  const t0 = performance.now();
  const tick = () =>
    setStatsLine(msgEl, `🎨 画像を生成中… ${fmtSec(performance.now() - t0)}`, true);
  tick();
  const timer = setInterval(tick, 100);

  try {
    const result = await generateImage({ provider, model, prompt, signal: abortController.signal });
    assistantMsg.images = await storeImages(result.images);
    assistantMsg.content = result.images.length
      ? result.revisedPrompt
      : "⚠️ サーバーから画像が返されませんでした。";
    assistantMsg.stats = { kind: "image", totalMs: performance.now() - t0, count: result.images.length };
    els.composerHint.textContent = "";
  } catch (err) {
    if (err.name === "AbortError") {
      assistantMsg.content = "*（停止しました）*";
    } else {
      console.error(err);
      assistantMsg.content =
        `⚠️ エラー: ${err.message}` +
        (/HTTP 40[45]/.test(err.message)
          ? "\n\nこのサーバーには画像生成用の窓口（/images/generations）がないようです。" +
            "「🖼 画像生成」をオフにして、通常のチャットとして送ってみてください。"
          : "");
    }
  }

  clearInterval(timer);
  if (assistantMsg.stats) setStatsLine(msgEl, formatStats(assistantMsg.stats));
  else msgEl.querySelector(".msg-stats")?.remove();
  contentEl.innerHTML = renderMarkdown(assistantMsg.content);
  contentEl.classList.remove("cursor-blink");
  renderImageGallery(msgEl, assistantMsg.images || []);
  scrollToBottom();
  setStreaming(false);
  abortController = null;
  save();
}

/* Image mode is remembered per model, since only some models draw. */
function isImageMode(model = els.modelSelect.value) {
  return !!state.settings.imageModels?.[model];
}

function renderModeToggles() {
  const img = isImageMode();
  els.imageToggle.classList.toggle("on", img);
  els.imageToggle.setAttribute("aria-pressed", String(img));
  els.imageToggle.title = img
    ? "画像生成モード: 入力をそのまま画像生成（/images/generations）に送ります。クリックで通常チャットに戻します"
    : "クリックでこのモデルを画像生成モードにします。チャットの返答に含まれる画像は、通常モードのままでも表示・保存できます";
  els.thinkToggle.hidden = img;
  els.sendBtn.textContent = img ? "生成" : "送信";
  els.promptInput.placeholder = img
    ? "生成したい画像の説明を入力 (Enterで生成)"
    : "メッセージを入力 (Enterで送信 / Shift+Enterで改行)";
}

function stopStreaming() {
  if (abortController) abortController.abort();
}

/* ------------------------------------------------------------------ *
 * Settings modal
 * ------------------------------------------------------------------ */
function openSettings() {
  els.systemPrompt.value = state.settings.systemPrompt || "";
  els.temperature.value = state.settings.temperature ?? 0.7;
  els.tempValue.textContent = els.temperature.value;
  els.maxTokens.value = state.settings.maxTokens ?? "";
  renderProvidersEditor();
  els.settingsModal.hidden = false;
}

function closeSettings() {
  els.settingsModal.hidden = true;
}

function renderProvidersEditor() {
  els.providersEditor.innerHTML = "";
  state.providers.forEach((p, idx) => {
    const card = document.createElement("div");
    card.className = "provider-card";
    card.innerHTML = `
      <div class="card-head">
        <strong>プロバイダ #${idx + 1}</strong>
        <button class="btn-icon" data-act="remove">削除</button>
      </div>
      <div class="row">
        <label>表示名</label>
        <input type="text" data-f="name" value="${escapeAttr(p.name)}" />
      </div>
      <div class="row">
        <label>種類</label>
        <select data-f="type">
          <option value="ollama" ${p.type === "ollama" ? "selected" : ""}>Ollama</option>
          <option value="openai" ${p.type === "openai" ? "selected" : ""}>OpenAI互換 (LM Studio等)</option>
        </select>
      </div>
      <div class="row">
        <label>Base URL</label>
        <input type="url" data-f="baseUrl" value="${escapeAttr(p.baseUrl)}" />
      </div>
      <div class="row">
        <label>API Key</label>
        <input type="text" data-f="apiKey" value="${escapeAttr(p.apiKey || "")}" placeholder="任意" />
      </div>
      <button class="btn-ghost" data-act="test" style="width:auto;padding:6px 12px;">接続テスト</button>
      <div class="provider-test" data-test></div>
    `;

    card.querySelectorAll("[data-f]").forEach((input) => {
      input.addEventListener("input", () => {
        p[input.dataset.f] = input.value;
      });
    });
    card.querySelector('[data-act="remove"]').addEventListener("click", () => {
      state.providers.splice(idx, 1);
      renderProvidersEditor();
    });
    card.querySelector('[data-act="test"]').addEventListener("click", async () => {
      const testEl = card.querySelector("[data-test]");
      testEl.textContent = "テスト中…";
      testEl.className = "provider-test";
      try {
        const models = await listModels(p);
        testEl.textContent = `✓ 接続成功 — ${models.length} モデル`;
        testEl.className = "provider-test ok";
      } catch (err) {
        testEl.textContent = `✕ 失敗: ${err.message}`;
        testEl.className = "provider-test err";
      }
    });

    els.providersEditor.appendChild(card);
  });
}

function addProvider() {
  state.providers.push({
    id: crypto.randomUUID(),
    name: "新しいプロバイダ",
    type: "ollama",
    baseUrl: "http://localhost:11434",
    apiKey: "",
  });
  renderProvidersEditor();
}

function saveSettings() {
  state.settings.systemPrompt = els.systemPrompt.value;
  state.settings.temperature = parseFloat(els.temperature.value);
  const mt = els.maxTokens.value.trim();
  state.settings.maxTokens = mt === "" ? null : parseInt(mt, 10);
  save();
  renderProviderSelect();
  refreshModels();
  closeSettings();
}

function escapeAttr(s) {
  return String(s).replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/* ------------------------------------------------------------------ *
 * Composer behavior
 * ------------------------------------------------------------------ */
function autoResize() {
  els.promptInput.style.height = "auto";
  els.promptInput.style.height = Math.min(els.promptInput.scrollHeight, 200) + "px";
}

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */
function init() {
  // marked config
  window.marked.setOptions({ breaks: true, gfm: true });

  els.newChat.addEventListener("click", newConversation);
  els.sendBtn.addEventListener("click", sendMessage);
  els.stopBtn.addEventListener("click", stopStreaming);
  els.refreshModels.addEventListener("click", refreshModels);

  els.thinkToggle.addEventListener("click", () => {
    state.settings.thinking = state.settings.thinking === false;
    save();
    renderThinkToggle();
  });
  renderThinkToggle();

  els.imageToggle.addEventListener("click", () => {
    const model = els.modelSelect.value;
    if (!model) {
      els.composerHint.textContent = "先にモデルを選択してください。";
      return;
    }
    state.settings.imageModels = { ...state.settings.imageModels, [model]: !isImageMode(model) };
    save();
    renderModeToggles();
  });
  renderModeToggles();

  els.messages.addEventListener("scroll", () => {
    stickToBottom = isNearBottom(els.messages, 60);
    updateJumpButton();
  });
  els.jumpLatest.addEventListener("click", () => {
    els.messages.scrollTo({ top: els.messages.scrollHeight, behavior: "smooth" });
    stickToBottom = true;
    updateJumpButton();
  });

  els.promptInput.addEventListener("input", autoResize);
  els.promptInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendMessage();
    }
  });

  els.providerSelect.addEventListener("change", () => {
    state.selectedProviderId = els.providerSelect.value;
    state.selectedModel = null;
    save();
    refreshModels();
  });
  els.modelSelect.addEventListener("change", () => {
    state.selectedModel = els.modelSelect.value;
    renderModeToggles();
    save();
  });

  els.chatTitle.title = "ダブルクリックで名前を変更";
  els.chatTitle.addEventListener("dblclick", () => {
    const conv = activeConversation();
    if (!conv) return;
    const next = prompt("チャット名を変更", conv.title || "");
    if (next === null) return;
    conv.title = next.trim() || "新しいチャット";
    save();
    renderConversationList();
    renderMessages();
  });

  els.openSettings.addEventListener("click", openSettings);
  els.closeSettings.addEventListener("click", closeSettings);
  els.addProvider.addEventListener("click", addProvider);
  els.saveSettings.addEventListener("click", saveSettings);
  els.temperature.addEventListener("input", () => {
    els.tempValue.textContent = els.temperature.value;
  });
  els.settingsModal.addEventListener("click", (e) => {
    if (e.target === els.settingsModal) closeSettings();
  });

  // initial render
  if (!state.selectedProviderId && state.providers[0]) {
    state.selectedProviderId = state.providers[0].id;
  }
  renderProviderSelect();
  renderConversationList();
  renderMessages();
  refreshModels();
}

init();
