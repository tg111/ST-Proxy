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

function responseText(body) {
  return body?.choices?.[0]?.message?.content || body?.choices?.[0]?.text || "";
}

function responseFinishReason(body) {
  return body?.choices?.[0]?.finish_reason || body?.choices?.[0]?.finishReason || "stop";
}

module.exports = {
  normalizeBase,
  estimateTokens,
  preview,
  upstreamError,
  usageErrorDetail,
  responseText,
  responseFinishReason
};
