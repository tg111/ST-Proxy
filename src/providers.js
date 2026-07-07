const { openaiUrl } = require("./channels");
const { preview, responseOutputText, upstreamError } = require("./utils");

async function testChannel(channel, message = "你好") {
  if (channel.enabled === false) throw new Error("Channel is disabled");
  const model = (channel.models || []).find(item => item.enabled) || (channel.models || [])[0];
  if (!model) throw new Error("No model found for this channel. Please fetch models first.");
  const body = {
    model: model.alias || model.id,
    input: message || "你好"
  };
  const upstream = await callResponses(channel, model.id, body);
  return { model, upstream };
}

async function callResponses(channel, modelId, body) {
  const upstreamBody = { ...body, model: modelId };
  const upstreamUrl = openaiUrl(channel.apiBase, "/responses");
  const res = await fetch(upstreamUrl, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${channel.apiKey}` },
    body: JSON.stringify(upstreamBody)
  });

  if (body.stream === true) {
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw upstreamError(`Responses request failed: ${res.status}`, {
        upstreamStatus: res.status,
        upstreamUrl,
        upstreamBody: preview(text)
      });
    }
    return {
      stream: true,
      status: res.status,
      headers: {
        "content-type": res.headers.get("content-type") || "text/event-stream; charset=utf-8",
        "cache-control": res.headers.get("cache-control") || "no-cache",
        connection: res.headers.get("connection") || "keep-alive"
      },
      body: res.body
    };
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw upstreamError(data.error?.message || `Responses request failed: ${res.status}`, {
    upstreamStatus: res.status,
    upstreamUrl,
    upstreamBody: preview(data)
  });
  return { stream: false, status: res.status, body: data };
}

module.exports = {
  testChannel,
  callResponses,
  responseOutputText
};
