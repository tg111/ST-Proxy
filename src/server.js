const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");

const ROOT_DIR = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT_DIR, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const CONFIG_FILE = path.join(ROOT_DIR, "config.json");
const config = loadConfig();
const PORT = Number(process.env.PORT || config.port || 3000);

const jsonType = { "content-type": "application/json; charset=utf-8" };
const textType = { "content-type": "text/plain; charset=utf-8" };
const htmlType = { "content-type": "text/html; charset=utf-8" };

const state = {
  db: { channels: [], usage: [] },
  rr: new Map(),
  apiKey: ""
};

function backupBadFile(file) {
  if (!fs.existsSync(file)) return;
  const backup = `${file}.bad-${Date.now()}`;
  try {
    fs.renameSync(file, backup);
    console.warn(`Invalid data file moved to ${backup}`);
  } catch (error) {
    console.warn(`Failed to backup invalid file ${file}: ${error.message}`);
  }
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    const next = { port: 3000, apiKey: "pwd" };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2));
    return next;
  }
  let current;
  try {
    current = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch (error) {
    console.warn(`Failed to read config.json: ${error.message}`);
    backupBadFile(CONFIG_FILE);
    const next = { port: 3000, apiKey: "pwd" };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2));
    return next;
  }
  const next = {
    port: current.port || 3000,
    apiKey: current.apiKey || "pwd"
  };
  if (next.port !== current.port || next.apiKey !== current.apiKey) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2));
  }
  return next;
}

function ensureData() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  state.apiKey = process.env.PROXY_API_KEY || config.apiKey;
  if (fs.existsSync(DB_FILE)) {
    try {
      const db = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
      state.db = {
        channels: Array.isArray(db.channels) ? db.channels : [],
        usage: Array.isArray(db.usage) ? db.usage : []
      };
    } catch (error) {
      console.warn(`Failed to read data/db.json: ${error.message}`);
      backupBadFile(DB_FILE);
      state.db = { channels: [], usage: [] };
      saveDb();
    }
  } else {
    saveDb();
  }
}

function saveDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(state.db, null, 2));
}

function send(res, status, body, headers = jsonType) {
  if (res.headersSent) return;
  res.writeHead(status, headers);
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

function sendJson(res, status, body) {
  send(res, status, body, jsonType);
}

function sendError(res, status, message, extra = {}) {
  sendJson(res, status, { error: { message, ...extra } });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(Object.assign(new Error("Invalid JSON body"), { statusCode: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function authKey(req) {
  const auth = req.headers.authorization || "";
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return req.headers["x-api-key"] || "";
}

function requireAuth(req, res) {
  if (authKey(req) === state.apiKey) return true;
  sendError(res, 401, "Unauthorized");
  return false;
}

function normalizeBase(apiBase) {
  return String(apiBase || "").trim().replace(/\/+$/, "");
}

function providerOf(channel) {
  if (channel.providerType && channel.providerType !== "auto") return channel.providerType;
  const base = normalizeBase(channel.apiBase).toLowerCase();
  if (base.includes("generativelanguage.googleapis.com")) return "gemini";
  if (base.includes("anthropic.com")) return "anthropic";
  return "openai";
}

function openaiUrl(base, suffix) {
  const clean = normalizeBase(base);
  if (clean.endsWith("/v1")) return `${clean}${suffix}`;
  return `${clean}/v1${suffix}`;
}

function geminiBase(base) {
  const clean = normalizeBase(base);
  return clean.endsWith("/v1beta") ? clean : `${clean}/v1beta`;
}

function publicChannel(channel, options = {}) {
  const { apiKey, ...safe } = channel;
  const usageCount = state.db.usage.filter(record => record.channelId === channel.id && record.success).length;
  return {
    ...safe,
    ...(options.includeKey ? { apiKey } : {}),
    hasKey: Boolean(apiKey),
    usageCount
  };
}

function sanitizeChannel(input, previous = {}) {
  const apiBase = normalizeBase(input.apiBase);
  const apiKey = typeof input.apiKey === "string" && input.apiKey ? input.apiKey : previous.apiKey;
  return {
    id: previous.id || crypto.randomUUID(),
    apiBase,
    apiKey,
    note: String(input.note || ""),
    providerLink: String(input.providerLink || ""),
    providerType: input.providerType || previous.providerType || "auto",
    enabled: input.enabled === undefined ? previous.enabled !== false : Boolean(input.enabled),
    models: Array.isArray(previous.models) ? previous.models : [],
    createdAt: previous.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

async function fetchModels(channel) {
  const provider = providerOf(channel);
  if (provider === "gemini") {
    const url = `${geminiBase(channel.apiBase)}/models?key=${encodeURIComponent(channel.apiKey)}`;
    const res = await fetch(url);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw upstreamError(body.error?.message || `Gemini model fetch failed: ${res.status}`, {
      upstreamStatus: res.status,
      upstreamUrl: url,
      upstreamBody: preview(body)
    });
    return (body.models || []).map(model => String(model.name || "").replace(/^models\//, "")).filter(Boolean);
  }

  const url = openaiUrl(channel.apiBase, "/models");
  const headers = provider === "anthropic"
    ? { "x-api-key": channel.apiKey, "anthropic-version": "2023-06-01" }
    : { authorization: `Bearer ${channel.apiKey}` };
  const res = await fetch(url, { headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw upstreamError(body.error?.message || `Model fetch failed: ${res.status}`, {
    upstreamStatus: res.status,
    upstreamUrl: url,
    upstreamBody: preview(body)
  });
  return (body.data || []).map(model => model.id).filter(Boolean);
}

function mergeModels(channel, fetched) {
  const oldById = new Map((channel.models || []).map(model => [model.id, model]));
  channel.models = fetched.map(id => {
    const old = oldById.get(id);
    return {
      id,
      alias: old?.alias || id,
      enabled: old ? Boolean(old.enabled) : true
    };
  });
  channel.updatedAt = new Date().toISOString();
}

function aliases() {
  const byAlias = new Map();
  for (const channel of state.db.channels) {
    if (channel.enabled === false) continue;
    for (const model of channel.models || []) {
      if (!model.enabled || !model.alias) continue;
      if (!byAlias.has(model.alias)) byAlias.set(model.alias, []);
      byAlias.get(model.alias).push({ channel, model });
    }
  }
  return byAlias;
}

function usageRecord(record) {
  state.db.usage.unshift({
    id: crypto.randomUUID(),
    time: new Date().toISOString(),
    ...record
  });
  state.db.usage = state.db.usage.slice(0, 1000);
  try {
    saveDb();
  } catch (error) {
    console.warn(`Failed to save usage record: ${error.message}`);
  }
}

function estimateTokens(body) {
  if (!body) return 0;
  if (body.usage?.total_tokens) return body.usage.total_tokens;
  const usage = body.usage || body.usageMetadata;
  return Number(usage?.input_tokens || 0)
    + Number(usage?.output_tokens || 0)
    + Number(usage?.promptTokenCount || 0)
    + Number(usage?.candidatesTokenCount || 0);
}

function preview(value, limit = 1200) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function upstreamError(message, detail = {}) {
  const error = new Error(message);
  Object.assign(error, detail);
  return error;
}

function usageErrorDetail(error, fallback = {}) {
  return {
    ...fallback,
    message: error.message,
    upstreamStatus: error.upstreamStatus || fallback.upstreamStatus || null,
    upstreamUrl: error.upstreamUrl || fallback.upstreamUrl || null,
    upstreamBody: error.upstreamBody || fallback.upstreamBody || null
  };
}

function sseChunk(data) {
  return Buffer.from(`data: ${JSON.stringify(data)}\n\n`, "utf8");
}

function openAIStreamChunk(alias, content, finishReason = null, id = `chatcmpl-${crypto.randomUUID()}`) {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: alias,
    choices: [{
      index: 0,
      delta: content ? { content } : {},
      finish_reason: finishReason
    }]
  };
}

function openAIFinishReason(reason) {
  const value = String(reason || "").toLowerCase();
  if (!value || value === "stop") return "stop";
  if (value === "max_tokens" || value === "max_output_tokens") return "length";
  if (value === "safety" || value === "recitation" || value === "blocklist" || value === "prohibited_content") return "content_filter";
  return value;
}

function createOpenAIStreamErrorDetector() {
  const decoder = new TextDecoder();
  let buffer = "";

  return chunk => {
    buffer += decoder.decode(chunk, { stream: true });
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() || "";

    for (const eventText of events) {
      for (const line of eventText.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            const error = parsed.error;
            return upstreamError(error.message || "OpenAI-compatible stream error", {
              upstreamStatus: error.status || error.code || null,
              upstreamBody: preview(parsed)
            });
          }
        } catch (error) {
          continue;
        }
      }
    }
    return null;
  };
}

async function* parseSse(stream) {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() || "";

    for (const eventText of events) {
      const event = { event: "", data: "" };
      for (const line of eventText.split(/\r?\n/)) {
        if (line.startsWith("event:")) event.event = line.slice(6).trim();
        if (line.startsWith("data:")) event.data += `${line.slice(5).trim()}\n`;
      }
      event.data = event.data.trim();
      if (event.data) yield event;
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    const event = { event: "", data: "" };
    for (const line of buffer.split(/\r?\n/)) {
      if (line.startsWith("event:")) event.event = line.slice(6).trim();
      if (line.startsWith("data:")) event.data += `${line.slice(5).trim()}\n`;
    }
    event.data = event.data.trim();
    if (event.data) yield event;
  }
}

async function* anthropicToOpenAIStream(stream, alias) {
  const id = `chatcmpl-${crypto.randomUUID()}`;
  let done = false;

  for await (const event of parseSse(stream)) {
    if (event.data === "[DONE]") continue;

    let data;
    try {
      data = JSON.parse(event.data);
    } catch (error) {
      continue;
    }

    if (data.type === "error" || data.error) {
      const err = data.error || data;
      throw upstreamError(err.message || "Anthropic stream error", {
        upstreamStatus: err.status || err.code || null,
        upstreamBody: preview(data)
      });
    }

    const text = data.type === "content_block_start"
      ? data.content_block?.text || ""
      : data.type === "content_block_delta"
        ? data.delta?.text || ""
        : "";

    if (text) yield sseChunk(openAIStreamChunk(alias, text, null, id));

    if (data.type === "message_stop") {
      done = true;
      yield sseChunk(openAIStreamChunk(alias, "", "stop", id));
      yield Buffer.from("data: [DONE]\n\n", "utf8");
    }
  }

  if (!done) {
    yield sseChunk(openAIStreamChunk(alias, "", "stop", id));
    yield Buffer.from("data: [DONE]\n\n", "utf8");
  }
}

async function* geminiToOpenAIStream(stream, alias) {
  const id = `chatcmpl-${crypto.randomUUID()}`;
  let done = false;

  for await (const event of parseSse(stream)) {
    if (event.data === "[DONE]") continue;

    let data;
    try {
      data = JSON.parse(event.data);
    } catch (error) {
      continue;
    }

    if (data.error) {
      throw upstreamError(data.error.message || "Gemini stream error", {
        upstreamStatus: data.error.status || data.error.code || null,
        upstreamBody: preview(data)
      });
    }

    for (const candidate of data.candidates || []) {
      const text = (candidate.content?.parts || []).map(part => part.text || "").join("");
      if (text) yield sseChunk(openAIStreamChunk(alias, text, null, id));

      if (candidate.finishReason) {
        done = true;
        yield sseChunk(openAIStreamChunk(alias, "", openAIFinishReason(candidate.finishReason), id));
        yield Buffer.from("data: [DONE]\n\n", "utf8");
        return;
      }
    }
  }

  if (!done) {
    yield sseChunk(openAIStreamChunk(alias, "", "stop", id));
    yield Buffer.from("data: [DONE]\n\n", "utf8");
  }
}

function sortedCandidates(alias) {
  const items = aliases().get(alias) || [];
  if (items.length <= 1) return items;
  const next = state.rr.get(alias) || 0;
  const rotated = [...items.slice(next), ...items.slice(0, next)];
  state.rr.set(alias, (next + 1) % items.length);
  return rotated;
}

function mapOpenAIToAnthropic(body, modelId) {
  const messages = [];
  let system = "";
  for (const message of body.messages || []) {
    if (message.role === "system") {
      system += `${message.content}\n`;
    } else {
      messages.push({
        role: message.role === "assistant" ? "assistant" : "user",
        content: typeof message.content === "string" ? message.content : JSON.stringify(message.content)
      });
    }
  }
  return {
    model: modelId,
    max_tokens: body.max_tokens || body.max_completion_tokens || 1024,
    temperature: body.temperature,
    system: system.trim() || undefined,
    messages
  };
}

function mapAnthropicToOpenAI(body, alias, modelId) {
  const text = (body.content || []).map(part => part.text || "").join("");
  return {
    id: body.id || `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: alias,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: body.stop_reason || "stop" }],
    usage: {
      prompt_tokens: body.usage?.input_tokens || 0,
      completion_tokens: body.usage?.output_tokens || 0,
      total_tokens: estimateTokens(body),
      source_model: modelId
    }
  };
}

function mapOpenAIToGemini(body) {
  const contents = [];
  const systemParts = [];
  for (const message of body.messages || []) {
    const text = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
    if (message.role === "system") {
      systemParts.push({ text });
    } else {
      contents.push({ role: message.role === "assistant" ? "model" : "user", parts: [{ text }] });
    }
  }
  return {
    contents,
    systemInstruction: systemParts.length ? { parts: systemParts } : undefined,
    generationConfig: {
      temperature: body.temperature,
      maxOutputTokens: body.max_tokens || body.max_completion_tokens
    }
  };
}

function mapGeminiToOpenAI(body, alias, modelId) {
  const candidate = body.candidates?.[0] || {};
  const text = (candidate.content?.parts || []).map(part => part.text || "").join("");
  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: alias,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: candidate.finishReason || "stop" }],
    usage: {
      prompt_tokens: body.usageMetadata?.promptTokenCount || 0,
      completion_tokens: body.usageMetadata?.candidatesTokenCount || 0,
      total_tokens: estimateTokens(body),
      source_model: modelId
    }
  };
}

async function proxyChat(req, res, body) {
  const alias = body.model;
  if (!alias) return sendError(res, 400, "Missing model");
  const candidates = sortedCandidates(alias);
  if (!candidates.length) return sendError(res, 404, `No enabled channel found for model alias: ${alias}`);

  const errors = [];
  for (const { channel, model } of candidates) {
    const provider = providerOf(channel);
    try {
      const upstream = await callProvider(provider, channel, model.id, alias, body, req.url);
      if (upstream.stream) {
        res.writeHead(upstream.status, upstream.headers);
        let bytes = 0;
        let streamErrorWritten = false;
        const detectOpenAIStreamError = provider === "openai" ? createOpenAIStreamErrorDetector() : null;
        try {
          for await (const chunk of upstream.body) {
            const streamError = detectOpenAIStreamError ? detectOpenAIStreamError(chunk) : null;
            bytes += chunk.length;
            res.write(chunk);
            if (streamError) {
              streamErrorWritten = true;
              throw streamError;
            }
          }
          res.end();
          usageRecord({ success: true, endpoint: req.url, tokenUsage: null, bytes, model: alias, sourceModel: model.id, channelId: channel.id, channelNote: channel.note, provider });
        } catch (error) {
          const detail = usageErrorDetail(error, {
            channelId: channel.id,
            channelNote: channel.note,
            provider,
            upstreamStatus: upstream.status === 200 ? null : upstream.status
          });
          usageRecord({ success: false, endpoint: req.url, tokenUsage: 0, bytes, model: alias, sourceModel: model.id, ...detail, error: error.message });
          if (!res.destroyed && !res.writableEnded) {
            if (!streamErrorWritten) res.write(sseChunk(openAIStreamChunk(alias, `Stream error: ${error.message}`, "stop")));
            res.write(Buffer.from("data: [DONE]\n\n", "utf8"));
            res.end();
          }
        }
        return;
      }

      usageRecord({ success: true, endpoint: req.url, tokenUsage: estimateTokens(upstream.body), model: alias, sourceModel: model.id, channelId: channel.id, channelNote: channel.note, provider });
      return sendJson(res, upstream.status, upstream.body);
    } catch (error) {
      const detail = usageErrorDetail(error, {
        channelId: channel.id,
        channelNote: channel.note,
        provider
      });
      errors.push(detail);
      usageRecord({ success: false, endpoint: req.url, tokenUsage: 0, model: alias, sourceModel: model.id, ...detail, error: error.message });
    }
  }
  const firstError = errors[0] || {};
  sendError(res, 502, firstError.message || "All matching channels failed", {
    errors,
    upstreamStatus: firstError.upstreamStatus || null,
    upstreamBody: firstError.upstreamBody || null
  });
}

async function testChannel(channel, message = "你好") {
  if (channel.enabled === false) throw new Error("Channel is disabled");
  const model = (channel.models || []).find(item => item.enabled) || (channel.models || [])[0];
  if (!model) throw new Error("No model found for this channel. Please fetch models first.");
  const provider = providerOf(channel);
  const alias = model.alias || model.id;
  const body = {
    model: alias,
    stream: provider === "openai",
    messages: [{ role: "user", content: message || "你好" }]
  };
  const upstream = await callProvider(provider, channel, model.id, alias, body, "/v1/chat/completions");
  if (upstream.stream) {
    upstream.body = await readOpenAIStream(upstream.body, alias, model.id);
    upstream.stream = false;
  }
  return { provider, model, upstream };
}

function responseText(body) {
  return body?.choices?.[0]?.message?.content || body?.choices?.[0]?.text || "";
}

async function readOpenAIStream(stream, alias, modelId) {
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";

  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const parsed = JSON.parse(data);
        text += parsed.choices?.[0]?.delta?.content || parsed.choices?.[0]?.text || "";
      } catch (error) {
        text += data;
      }
    }
  }

  buffer += decoder.decode();
  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: alias,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: {
      total_tokens: text ? Math.ceil(text.length / 4) : 0,
      source_model: modelId
    }
  };
}

async function callProvider(provider, channel, modelId, alias, body, requestPath) {
  if (provider === "anthropic") {
    const requestBody = mapOpenAIToAnthropic(body, modelId);
    if (body.stream) requestBody.stream = true;
    const upstreamUrl = openaiUrl(channel.apiBase, "/messages");
    const res = await fetch(upstreamUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": channel.apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify(requestBody)
    });

    if (body.stream) {
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw upstreamError(`Anthropic request failed: ${res.status}`, {
          upstreamStatus: res.status,
          upstreamUrl,
          upstreamBody: preview(text)
        });
      }
      return {
        stream: true,
        status: 200,
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive"
        },
        body: anthropicToOpenAIStream(res.body, alias)
      };
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw upstreamError(data.error?.message || `Anthropic request failed: ${res.status}`, {
      upstreamStatus: res.status,
      upstreamUrl,
      upstreamBody: preview(data)
    });
    return { status: 200, body: mapAnthropicToOpenAI(data, alias, modelId) };
  }

  if (provider === "gemini") {
    const endpoint = body.stream ? "streamGenerateContent" : "generateContent";
    const streamParam = body.stream ? "&alt=sse" : "";
    const url = `${geminiBase(channel.apiBase)}/models/${encodeURIComponent(modelId)}:${endpoint}?key=${encodeURIComponent(channel.apiKey)}${streamParam}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(mapOpenAIToGemini(body))
    });

    if (body.stream) {
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw upstreamError(`Gemini request failed: ${res.status}`, {
          upstreamStatus: res.status,
          upstreamUrl: url,
          upstreamBody: preview(text)
        });
      }
      return {
        stream: true,
        status: 200,
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive"
        },
        body: geminiToOpenAIStream(res.body, alias)
      };
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw upstreamError(data.error?.message || `Gemini request failed: ${res.status}`, {
      upstreamStatus: res.status,
      upstreamUrl: url,
      upstreamBody: preview(data)
    });
    return { status: 200, body: mapGeminiToOpenAI(data, alias, modelId) };
  }

  const upstreamBody = { ...body, model: modelId };
  const upstreamUrl = openaiUrl(channel.apiBase, requestPath.replace(/^\/v1/, ""));
  const res = await fetch(upstreamUrl, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${channel.apiKey}` },
    body: JSON.stringify(upstreamBody)
  });
  if (body.stream && !res.ok) {
    const text = await res.text().catch(() => "");
    throw upstreamError(`OpenAI-compatible request failed: ${res.status}`, {
      upstreamStatus: res.status,
      upstreamUrl,
      upstreamBody: preview(text)
    });
  }
  if (body.stream) {
    return {
      stream: true,
      status: res.status,
      headers: {
        "content-type": res.headers.get("content-type") || "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive"
      },
      body: res.body
    };
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw upstreamError(data.error?.message || `OpenAI-compatible request failed: ${res.status}`, {
    upstreamStatus: res.status,
    upstreamUrl,
    upstreamBody: preview(data)
  });
  return { status: res.status, body: data };
}

async function api(req, res, url) {
  if (req.method === "POST" && url.pathname === "/api/login") {
    const body = await readBody(req);
    return sendJson(res, body.apiKey === state.apiKey ? 200 : 401, { ok: body.apiKey === state.apiKey });
  }
  if (!requireAuth(req, res)) return;

  if (req.method === "GET" && url.pathname === "/api/channels") {
    return sendJson(res, 200, state.db.channels.map(publicChannel));
  }
  if (req.method === "POST" && url.pathname === "/api/channels") {
    const body = await readBody(req);
    if (!body.apiBase) return sendError(res, 400, "apiBase is required");
    const channel = sanitizeChannel(body);
    state.db.channels.unshift(channel);
    saveDb();
    return sendJson(res, 201, publicChannel(channel));
  }
  const channelMatch = url.pathname.match(/^\/api\/channels\/([^/]+)(?:\/(models|fetch-models|test|enabled))?$/);
  if (channelMatch) {
    const channel = state.db.channels.find(item => item.id === channelMatch[1]);
    if (!channel) return sendError(res, 404, "Channel not found");
    const action = channelMatch[2];
    if (req.method === "GET" && !action) {
      return sendJson(res, 200, publicChannel(channel, { includeKey: true }));
    }
    if (req.method === "PUT" && !action) {
      const body = await readBody(req);
      Object.assign(channel, sanitizeChannel(body, channel));
      saveDb();
      return sendJson(res, 200, publicChannel(channel));
    }
    if (req.method === "DELETE" && !action) {
      state.db.channels = state.db.channels.filter(item => item.id !== channel.id);
      saveDb();
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === "POST" && action === "fetch-models") {
      try {
        const models = await fetchModels(channel);
        mergeModels(channel, models);
        saveDb();
        return sendJson(res, 200, publicChannel(channel));
      } catch (error) {
        return sendJson(res, 200, {
          ok: false,
          message: error.message,
          upstreamStatus: error.upstreamStatus || null,
          upstreamBody: error.upstreamBody || null
        });
      }
    }
    if (req.method === "POST" && action === "test") {
      const body = await readBody(req);
      const testMessage = typeof body.message === "string" && body.message.trim() ? body.message.trim() : "你好";
      try {
        const result = await testChannel(channel, testMessage);
        usageRecord({
          success: true,
          endpoint: "/api/channels/:id/test",
          tokenUsage: estimateTokens(result.upstream.body),
          model: result.model.alias || result.model.id,
          sourceModel: result.model.id,
          channelId: channel.id,
          channelNote: channel.note,
          provider: result.provider,
          request: testMessage
        });
        return sendJson(res, 200, {
          ok: true,
          message: "Channel is available",
          request: testMessage,
          model: result.model.id,
          alias: result.model.alias || result.model.id,
          provider: result.provider,
          tokenUsage: estimateTokens(result.upstream.body),
          response: responseText(result.upstream.body)
        });
      } catch (error) {
        const model = (channel.models || []).find(item => item.enabled) || (channel.models || [])[0] || {};
        usageRecord({
          success: false,
          endpoint: "/api/channels/:id/test",
          tokenUsage: 0,
          model: model.alias || model.id || "",
          sourceModel: model.id || "",
          channelId: channel.id,
          channelNote: channel.note,
          provider: providerOf(channel),
          request: testMessage,
          error: error.message,
          upstreamStatus: error.upstreamStatus || null,
          upstreamUrl: error.upstreamUrl || null,
          upstreamBody: error.upstreamBody || null
        });
        return sendJson(res, 200, {
          ok: false,
          message: error.message,
          upstreamStatus: error.upstreamStatus || null,
          upstreamBody: error.upstreamBody || null
        });
      }
    }
    if (req.method === "PUT" && action === "enabled") {
      const body = await readBody(req);
      channel.enabled = Boolean(body.enabled);
      channel.updatedAt = new Date().toISOString();
      saveDb();
      return sendJson(res, 200, publicChannel(channel));
    }
    if (req.method === "PUT" && action === "models") {
      const body = await readBody(req);
      const updates = new Map((body.models || []).map(model => [model.id, model]));
      channel.models = (channel.models || []).map(model => {
        const next = updates.get(model.id) || {};
        return { ...model, enabled: Boolean(next.enabled), alias: String(next.alias || model.id) };
      });
      channel.updatedAt = new Date().toISOString();
      saveDb();
      return sendJson(res, 200, publicChannel(channel));
    }
  }
  if (req.method === "GET" && url.pathname === "/api/usage") {
    const limit = Math.min(Number(url.searchParams.get("limit") || 200), 1000);
    return sendJson(res, 200, state.db.usage.slice(0, limit));
  }
  if (req.method === "DELETE" && url.pathname === "/api/usage") {
    state.db.usage = [];
    saveDb();
    return sendJson(res, 200, { ok: true });
  }
  const usageMatch = url.pathname.match(/^\/api\/usage\/([^/]+)$/);
  if (usageMatch && req.method === "DELETE") {
    const before = state.db.usage.length;
    state.db.usage = state.db.usage.filter(record => record.id !== usageMatch[1]);
    if (state.db.usage.length === before) return sendError(res, 404, "Usage record not found");
    saveDb();
    return sendJson(res, 200, { ok: true });
  }
  sendError(res, 404, "Not found");
}

async function route(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname === "/health") return sendJson(res, 200, { ok: true });
    if (url.pathname === "/") {
      res.writeHead(302, { location: "/admin" });
      return res.end();
    }
    if (url.pathname.startsWith("/admin") || url.pathname.startsWith("/assets/")) {
      return staticFile(req, res, url);
    }
    if (url.pathname.startsWith("/api/")) return await api(req, res, url);
    if (url.pathname === "/v1/models") {
      if (!requireAuth(req, res)) return;
      const data = [...aliases().keys()].sort().map(id => ({ id, object: "model", created: 0, owned_by: "st-proxy" }));
      return sendJson(res, 200, { object: "list", data });
    }
    if (req.method === "POST" && ["/v1/chat/completions", "/v1/completions"].includes(url.pathname)) {
      if (!requireAuth(req, res)) return;
      const body = await readBody(req);
      return await proxyChat(req, res, body);
    }
    sendError(res, 404, "Not found");
  } catch (error) {
    if (!res.headersSent) sendError(res, error.statusCode || 500, error.message || "Internal server error");
    else res.destroy(error);
  }
}

function staticFile(req, res, url) {
  let file = url.pathname === "/admin" ? "admin.html" : url.pathname.replace(/^\/assets\//, "");
  const fullPath = path.resolve(PUBLIC_DIR, file);
  if (!fullPath.startsWith(PUBLIC_DIR) || !fs.existsSync(fullPath)) return sendError(res, 404, "Not found");
  const ext = path.extname(fullPath);
  const type = ext === ".html" ? htmlType : ext === ".css" ? { "content-type": "text/css; charset=utf-8" } : ext === ".js" ? { "content-type": "application/javascript; charset=utf-8" } : textType;
  res.writeHead(200, type);
  fs.createReadStream(fullPath)
    .on("error", error => {
      if (!res.headersSent) sendError(res, 500, error.message || "Failed to read file");
      else res.destroy(error);
    })
    .pipe(res);
}

ensureData();
const server = http.createServer((req, res) => {
  route(req, res).catch(error => {
    if (!res.headersSent) sendError(res, error.statusCode || 500, error.message || "Internal server error");
    else res.destroy(error);
  });
});

server.on("clientError", (error, socket) => {
  if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});

server.on("error", error => {
  console.error(`Server error: ${error.message}`);
  process.exitCode = 1;
});

server.listen(PORT, () => {
  console.log(`st-proxy listening on http://0.0.0.0:${PORT}`);
  console.log(`admin/proxy api key: ${state.apiKey}`);
});
