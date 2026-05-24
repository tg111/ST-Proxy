const crypto = require("crypto");
const { preview, upstreamError } = require("./utils");

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

function openAIStreamHeaders() {
  return {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive"
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

module.exports = {
  sseChunk,
  openAIStreamChunk,
  openAIStreamHeaders,
  openAIFinishReason,
  createOpenAIStreamErrorDetector,
  parseSse,
  anthropicToOpenAIStream,
  geminiToOpenAIStream,
  readOpenAIStream
};
