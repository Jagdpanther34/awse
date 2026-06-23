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
 * Calls onToken(textChunk) for each delta. Resolves when the stream ends.
 * ------------------------------------------------------------------ */
export async function streamChat({ provider, model, messages, options, signal, onToken }) {
  if (provider.type === "ollama") {
    return streamOllama({ provider, model, messages, options, signal, onToken });
  }
  return streamOpenAI({ provider, model, messages, options, signal, onToken });
}

async function streamOllama({ provider, model, messages, options, signal, onToken }) {
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
    const chunk = obj.message?.content;
    if (chunk) onToken(chunk);
  });
}

async function streamOpenAI({ provider, model, messages, options, signal, onToken }) {
  const body = {
    model,
    messages,
    stream: true,
  };
  if (options.temperature != null) body.temperature = options.temperature;
  if (options.maxTokens != null) body.max_tokens = options.maxTokens;

  const res = await fetch(joinUrl(provider.baseUrl, "/chat/completions"), {
    method: "POST",
    headers: authHeaders(provider),
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await safeText(res)}`);
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
    const chunk = obj.choices?.[0]?.delta?.content;
    if (chunk) onToken(chunk);
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

async function safeText(res) {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return "";
  }
}
