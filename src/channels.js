const crypto = require("crypto");
const { state } = require("./state");
const { normalizeBase, preview, upstreamError } = require("./utils");

const SAMPLING_PARAMETERS = [
  "temperature",
  "top_p",
  "top_k",
  "frequency_penalty",
  "presence_penalty"
];

function defaultParameterPass() {
  return Object.fromEntries(SAMPLING_PARAMETERS.map(name => [name, true]));
}

function sanitizeParameterPass(input, previous = {}) {
  const source = input && typeof input === "object" ? input : null;
  if (!source) return { ...defaultParameterPass(), ...(previous || {}) };
  return Object.fromEntries(SAMPLING_PARAMETERS.map(name => [name, source[name] !== false && source[name] !== "false"]));
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
    stream: channel.stream !== false,
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
    stream: input.stream === undefined ? previous.stream !== false : input.stream !== false && input.stream !== "false",
    parameterPass: sanitizeParameterPass(input.parameterPass, previous.parameterPass),
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

function sortedCandidates(alias) {
  const items = aliases().get(alias) || [];
  if (items.length <= 1) return items;
  const next = state.rr.get(alias) || 0;
  const rotated = [...items.slice(next), ...items.slice(0, next)];
  state.rr.set(alias, (next + 1) % items.length);
  return rotated;
}

module.exports = {
  SAMPLING_PARAMETERS,
  providerOf,
  openaiUrl,
  geminiBase,
  publicChannel,
  sanitizeChannel,
  fetchModels,
  mergeModels,
  aliases,
  sortedCandidates
};
