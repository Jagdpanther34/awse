// Provider abstraction layer.
// Supports two API shapes commonly used by local LLM servers:
//   - "ollama":  Ollama native API   (default port 11434)
//   - "openai":  OpenAI-compatible    (LM Studio, llama.cpp server, vLLM, etc.)

function joinUrl(base, path) {
  return base.replace(/\/+$/, "") + path;
}

function authHeaders(provider) {
  const h = { "Content-Type": "application/json" };
  if (provider.apiKey) h["Authorization"] = `Bearer ${provider.apiKey}`;
  return h;
}

/* ------------------------------------------------------------------ *
 * List models
 * ------------------------------------------------------------------ */
export async function listModels(provider) {
  if (provider.type === "ollama") {
    const res = await fetch(joinUrl(provider.baseUrl, "/api/tags"), {
      headers: authHeaders(provider),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return (data.models || []).map((m) => m.name).sort();
  }

  // openai-compatible
  const res = await fetch(joinUrl(provider.baseUrl, "/models"), {
    headers: authHeaders(provider),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return (data.data || []).map((m) => m.id).sort();
}

/* ------------------------------------------------------------------ *
 * Streaming chat
 *
 * Calls onToken(textChunk) for each answer delta, onReasoning(textChunk)
 * for reasoning-model "thinking" deltas sent in a separate field,
 * onImage(src) for images the model returns (URL or data: URL), and
 * onUsage({ input, output }) if the server reports real token counts.
 * Resolves when the stream ends.
 * ------------------------------------------------------------------ */
export async function streamChat({ provider, model, messages, options, signal, onToken, onReasoning, onImage, onUsage, onNotice }) {
  const args = {
    provider,
    model,
    messages,
    options,
    signal,
    onToken,
    onReasoning: onReasoning || (() => {}),
    onImage: onImage || (() => {}),
    onUsage: onUsage || (() => {}),
    onNotice: onNotice || (() => {}),
  };
  if (provider.type === "ollama") return streamOllama(args);
  return streamOpenAI(args);
}

// Messages may carry `images: [dataUrl…]` (user attachments); each API
// expects them in a different shape.
function toOllamaMessages(messages) {
  return messages.map(({ images, ...m }) =>
    images?.length ? { ...m, images: images.map((u) => u.slice(u.indexOf(",") + 1)) } : m
  );
}

function toOpenAIMessages(messages) {
  return messages.map(({ images, ...m }) => {
    if (!images?.length) return m;
    const parts = m.content ? [{ type: "text", text: m.content }] : [];
    for (const url of images) parts.push({ type: "image_url", image_url: { url } });
    return { ...m, content: parts };
  });
}

async function streamOllama({ provider, model, messages, options, signal, onToken, onReasoning, onUsage }) {
  const body = {
    model,
    messages: toOllamaMessages(messages),
    stream: true,
    options: {},
  };
  if (options.temperature != null) body.options.temperature = options.temperature;
  if (options.maxTokens != null) body.options.num_predict = options.maxTokens;
  if (options.thinking === false) body.think = false;

  const post = () =>
    fetch(joinUrl(provider.baseUrl, "/api/chat"), {
      method: "POST",
      headers: authHeaders(provider),
      body: JSON.stringify(body),
      signal,
    });
  let res = await post();
  // older Ollama versions may not know "think"
  if (res.status === 400 && "think" in body) {
    delete body.think;
    res = await post();
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await safeText(res)}`);
  }

  // Ollama streams newline-delimited JSON objects.
  await readLines(res.body, (line) => {
    if (!line.trim()) return;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      return;
    }
    const thinking = obj.message?.thinking;
    if (thinking) onReasoning(thinking);
    const chunk = obj.message?.content;
    if (chunk) onToken(chunk);
    if (obj.done && obj.eval_count != null) {
      onUsage({ input: obj.prompt_eval_count ?? 0, output: obj.eval_count });
    }
  });
}

// Optional params a server rejected, remembered per baseUrl+model so later
// requests don't pay for another failed round trip.
const rejectedParams = new Map();
const OPTIONAL_PARAMS = [
  "stream_options",
  "reasoning_effort",
  "chat_template_kwargs",
  "think",
  "temperature",
  "max_tokens",
];

function applyRejected(body, rejected) {
  if (rejected.has("use_max_completion_tokens") && body.max_tokens != null) {
    body.max_completion_tokens = body.max_tokens;
  }
  for (const key of rejected) delete body[key];
}

function pickRejectedParam(body, errText) {
  const present = OPTIONAL_PARAMS.filter((k) => k in body);
  if (!present.length) return null;
  const named = present.find((k) => errText.includes(k));
  if (named) return named;
  // the model can't take images: no param will fix that, don't re-upload them
  if (/image|vision|multimodal|multi-modal/i.test(errText)) return null;
  return present[0];
}

async function streamOpenAI({ provider, model, messages, options, signal, onToken, onReasoning, onImage, onUsage, onNotice }) {
  const body = {
    model,
    messages: toOpenAIMessages(messages),
    stream: true,
    // ask for real token counts in the final chunk
    stream_options: { include_usage: true },
  };
  if (options.temperature != null) body.temperature = options.temperature;
  if (options.maxTokens != null) body.max_tokens = options.maxTokens;
  if (options.thinking === false) {
    // There is no standard switch, so send what each server family reads;
    // ones a server rejects are dropped by the 400 fallback below.
    body.chat_template_kwargs = { enable_thinking: false, thinking: false }; // vLLM / SGLang / llama.cpp (Qwen3, DeepSeek)
    body.reasoning_effort = "none"; // OpenAI-style reasoning models
    body.think = false; // Ollama
  }

  // temperature rejections are cached per value: a model may accept 0.8
  // but reject 1.5, so changing the value should get a fresh try.
  const cacheKey = `${provider.baseUrl}|${model}`;
  const tempKey = `temperature@${options.temperature}`;
  const cached = rejectedParams.get(cacheKey) || new Set();
  const rejected = new Set([...cached].filter((k) => !k.startsWith("temperature@")));
  if (cached.has(tempKey)) rejected.add("temperature");
  applyRejected(body, rejected);

  const post = () =>
    fetch(joinUrl(provider.baseUrl, "/chat/completions"), {
      method: "POST",
      headers: authHeaders(provider),
      body: JSON.stringify(body),
      signal,
    });

  // Servers/models differ in which optional params they accept (e.g. some
  // only allow the default temperature, or a 0–1 range). On 400/422, drop
  // the param the error names (else the next optional one) and retry.
  let res = await post();
  while (res.status === 400 || res.status === 422) {
    const errText = await safeText(res, 2000);
    const key = pickRejectedParam(body, errText);
    if (!key) throw new Error(`HTTP ${res.status}: ${errText.slice(0, 200)}`);
    rejected.add(key);
    // newer OpenAI-style models want max_completion_tokens instead
    if (key === "max_tokens" && errText.includes("max_completion_tokens")) {
      rejected.add("use_max_completion_tokens");
    }
    applyRejected(body, rejected);
    res = await post();
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await safeText(res)}`);
  }
  if (rejected.size) {
    for (const k of rejected) cached.add(k === "temperature" ? tempKey : k);
    rejectedParams.set(cacheKey, cached);
  }
  if (rejected.has("temperature") && options.temperature != null) {
    onNotice("このモデルは temperature の指定を受け付けないため、サーバー既定値で生成しました。");
  }

  const handlers = { onToken, onReasoning, onImage };
  const emitUsage = (usage) => {
    if (usage?.completion_tokens != null) {
      onUsage({ input: usage.prompt_tokens ?? 0, output: usage.completion_tokens });
    }
  };

  // Some servers (often image models) ignore stream:true and reply with
  // one JSON body instead of Server-Sent Events.
  if ((res.headers.get("content-type") || "").includes("application/json")) {
    const obj = await res.json();
    emitParts(obj.choices?.[0]?.message, handlers);
    emitUsage(obj.usage);
    return;
  }

  // OpenAI streams Server-Sent Events: lines starting with "data: ".
  await readLines(res.body, (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const payload = trimmed.slice(5).trim();
    if (payload === "[DONE]") return;
    let obj;
    try {
      obj = JSON.parse(payload);
    } catch {
      return;
    }
    emitParts(obj.choices?.[0]?.delta, handlers);
    emitUsage(obj.usage);
  });
}

// Emits text, reasoning and images from a chat message or stream delta.
// Images can arrive as content-array parts, or an `images` array
// (OpenRouter style); markdown ![](…) images in text are handled in app.js.
function emitParts(m, { onToken, onReasoning, onImage }) {
  if (!m) return;
  // vLLM / llama.cpp / LM Studio send reasoning in a separate field
  const thinking = m.reasoning_content ?? m.reasoning;
  if (typeof thinking === "string" && thinking) onReasoning(thinking);
  if (typeof m.content === "string") {
    if (m.content) onToken(m.content);
  } else if (Array.isArray(m.content)) {
    for (const part of m.content) {
      if (typeof part?.text === "string") {
        if (part.text) onToken(part.text);
      } else {
        const src = imageSrc(part);
        if (src) onImage(src);
      }
    }
  }
  if (Array.isArray(m.images)) {
    for (const part of m.images) {
      const src = imageSrc(part);
      if (src) onImage(src);
    }
  }
}

// Normalizes the many image shapes servers use into a URL or data: URL.
function imageSrc(part) {
  if (!part || typeof part !== "object") return null;
  const url = part.image_url?.url ?? part.image_url ?? part.url;
  if (typeof url === "string" && url) return url;
  const b64 = part.b64_json ?? part.image_base64 ?? part.image?.data ?? part.data;
  if (typeof b64 === "string" && b64) {
    if (b64.startsWith("data:")) return b64;
    const mime = part.mime_type ?? part.image?.mime_type ?? part.output_format;
    const type = mime ? (mime.includes("/") ? mime : `image/${mime}`) : "image/png";
    return `data:${type};base64,${b64}`;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Image generation (OpenAI Images API)
 *   no source images → POST /images/generations (JSON)
 *   source images    → POST /images/edits (multipart, image to edit)
 * `sources` is [{ blob, name }]. Resolves to { images: [src…], revisedPrompt }.
 * ------------------------------------------------------------------ */
export async function generateImage({ provider, model, prompt, sources = [], signal }) {
  const base = provider.type === "ollama" ? joinUrl(provider.baseUrl, "/v1") : provider.baseUrl;
  const body = { model, prompt, n: 1, response_format: "b64_json" };
  const post = () => {
    if (!sources.length) {
      return fetch(joinUrl(base, "/images/generations"), {
        method: "POST",
        headers: authHeaders(provider),
        body: JSON.stringify(body),
        signal,
      });
    }
    const form = new FormData();
    for (const [k, v] of Object.entries(body)) form.append(k, String(v));
    // a single image is "image"; several follow OpenAI's "image[]"
    const field = sources.length === 1 ? "image" : "image[]";
    for (const s of sources) form.append(field, s.blob, s.name);
    const headers = authHeaders(provider);
    delete headers["Content-Type"]; // the browser sets the multipart boundary
    return fetch(joinUrl(base, "/images/edits"), { method: "POST", headers, body: form, signal });
  };

  let res = await post();
  // some servers only return URLs, or don't know response_format
  if (res.status === 400 || res.status === 422) {
    const errText = await safeText(res, 2000);
    if (!errText.includes("response_format")) {
      throw new Error(`HTTP ${res.status}: ${errText.slice(0, 200)}`);
    }
    delete body.response_format;
    res = await post();
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await safeText(res)}`);
  }
  const data = await res.json();
  const items = data.data || [];
  return {
    images: items.map(imageSrc).filter(Boolean),
    revisedPrompt: items[0]?.revised_prompt || "",
  };
}

/* ------------------------------------------------------------------ *
 * Stream utilities
 * ------------------------------------------------------------------ */
async function readLines(stream, onLine) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        onLine(line);
      }
    }
    if (buffer.trim()) onLine(buffer);
  } finally {
    reader.releaseLock();
  }
}

async function safeText(res, limit = 200) {
  try {
    return (await res.text()).slice(0, limit);
  } catch {
    return "";
  }
}
