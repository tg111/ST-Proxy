function normalizeBase(apiBase) {
  return String(apiBase || "").trim().replace(/\/+$/, "");
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

function responseOutputText(body) {
  if (typeof body?.output_text === "string") return body.output_text;
  const output = Array.isArray(body?.output) ? body.output : [];
  return output.flatMap(item => Array.isArray(item.content) ? item.content : [])
    .map(part => part.text || "")
    .join("");
}

module.exports = {
  normalizeBase,
  estimateTokens,
  preview,
  upstreamError,
  usageErrorDetail,
  responseOutputText
};
