// LocalLLM Studio — browser-based client for local LLM servers (Ollama / OpenAI-compatible).
// No build step: plain ES module. State persists in localStorage.

import { listModels, streamChat } from "./providers.js";
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
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

/* ------------------------------------------------------------------ *
 * DOM refs
 * ------------------------------------------------------------------ */
const $ = (sel) => document.querySelector(sel);

const els = {
  main: $("#main"),
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

function scrollToBottom() {
  els.messages.scrollTop = els.messages.scrollHeight;
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
    els.messages.appendChild(buildMessageEl(msg.role, msg.content));
  }
  scrollToBottom();
}

function buildMessageEl(role, content) {
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

  body.appendChild(roleName);
  body.appendChild(contentEl);
  wrap.appendChild(avatar);
  wrap.appendChild(body);
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
  const msgEl = buildMessageEl("assistant", "");
  const contentEl = msgEl.querySelector(".content");
  contentEl.classList.add("cursor-blink");
  els.messages.appendChild(msgEl);
  scrollToBottom();

  // assemble request messages (with system prompt)
  const reqMessages = [];
  if (state.settings.systemPrompt?.trim()) {
    reqMessages.push({ role: "system", content: state.settings.systemPrompt.trim() });
  }
  for (const m of conv.messages) {
    if (m === assistantMsg) continue; // skip the empty placeholder
    reqMessages.push({ role: m.role, content: m.content });
  }

  abortController = new AbortController();
  setStreaming(true);

  try {
    await streamChat({
      provider,
      model,
      messages: reqMessages,
      options: {
        temperature: state.settings.temperature,
        maxTokens: state.settings.maxTokens,
      },
      signal: abortController.signal,
      onToken: (chunk) => {
        assistantMsg.content += chunk;
        contentEl.innerHTML = renderMarkdown(assistantMsg.content);
        contentEl.classList.add("cursor-blink");
        scrollToBottom();
      },
    });
    els.composerHint.textContent = "";
  } catch (err) {
    if (err.name === "AbortError") {
      assistantMsg.content += "\n\n*（停止しました）*";
    } else {
      assistantMsg.content +=
        (assistantMsg.content ? "\n\n" : "") +
        `⚠️ エラー: ${err.message}`;
      console.error(err);
    }
    contentEl.innerHTML = renderMarkdown(assistantMsg.content);
  } finally {
    contentEl.classList.remove("cursor-blink");
    setStreaming(false);
    abortController = null;
    save();
  }
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
