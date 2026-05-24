const { providerOf, openaiUrl, geminiBase } = require("./channels");
const { preview, upstreamError } = require("./utils");
const {
  anthropicToOpenAIStream,
  geminiToOpenAIStream,
  openAIStreamHeaders,
  readOpenAIStream
} = require("./stream");
const {
  mapOpenAIToAnthropic,
  mapAnthropicToOpenAI,
  mapOpenAIToGemini,
  mapGeminiToOpenAI
} = require("./transforms");

async function testChannel(channel, message = "你好") {
  if (channel.enabled === false) throw new Error("Channel is disabled");
  const model = (channel.models || []).find(item => item.enabled) || (channel.models || [])[0];
  if (!model) throw new Error("No model found for this channel. Please fetch models first.");
  const provider = providerOf(channel);
  const alias = model.alias || model.id;
  const body = {
    model: alias,
    stream: provider === "openai" && channel.stream !== false,
    messages: [{ role: "user", content: message || "你好" }]
  };
  const upstream = await callProvider(provider, channel, model.id, alias, body, "/v1/chat/completions");
  if (upstream.stream) {
    upstream.body = await readOpenAIStream(upstream.body, alias, model.id);
    upstream.stream = false;
  }
  return { provider, model, upstream };
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
        headers: openAIStreamHeaders(),
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
        headers: openAIStreamHeaders(),
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
        ...openAIStreamHeaders(),
        "content-type": res.headers.get("content-type") || "text/event-stream; charset=utf-8",
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

module.exports = {
  testChannel,
  callProvider
};
