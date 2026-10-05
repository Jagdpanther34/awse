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
 * for reasoning-model "thinking" deltas sent in a separate field, and
 * onUsage({ input, output }) if the server reports real token counts.
 * Resolves when the stream ends.
 * ------------------------------------------------------------------ */
export async function streamChat({ provider, model, messages, options, signal, onToken, onReasoning, onUsage, onNotice }) {
  const args = {
    provider,
    model,
    messages,
    options,
    signal,
    onToken,
    onReasoning: onReasoning || (() => {}),
    onUsage: onUsage || (() => {}),
    onNotice: onNotice || (() => {}),
  };
  if (provider.type === "ollama") return streamOllama(args);
  return streamOpenAI(args);
}

async function streamOllama({ provider, model, messages, options, signal, onToken, onReasoning, onUsage }) {
  const body = {
    model,
    messages,
    stream: true,
    options: {},
  };
  if (options.temperature != null) body.options.temperature = options.temperature;
  if (options.maxTokens != null) body.options.num_predict = options.maxTokens;

  const res = await fetch(joinUrl(provider.baseUrl, "/api/chat"), {
    method: "POST",
    headers: authHeaders(provider),
    body: JSON.stringify(body),
    signal,
  });
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
const OPTIONAL_PARAMS = ["stream_options", "temperature", "max_tokens"];

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
  return named || present[0];
}

async function streamOpenAI({ provider, model, messages, options, signal, onToken, onReasoning, onUsage, onNotice }) {
  const body = {
    model,
    messages,
    stream: true,
    // ask for real token counts in the final chunk
    stream_options: { include_usage: true },
  };
  if (options.temperature != null) body.temperature = options.temperature;
  if (options.maxTokens != null) body.max_tokens = options.maxTokens;

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
    const delta = obj.choices?.[0]?.delta;
    // vLLM / llama.cpp / LM Studio send reasoning in a separate field
    const thinking = delta?.reasoning_content ?? delta?.reasoning;
    if (thinking) onReasoning(thinking);
    if (delta?.content) onToken(delta.content);
    if (obj.usage?.completion_tokens != null) {
      onUsage({ input: obj.usage.prompt_tokens ?? 0, output: obj.usage.completion_tokens });
    }
  });
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
