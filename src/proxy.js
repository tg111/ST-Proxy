const crypto = require("crypto");
const { usageRecord } = require("./state");
const { sendError, sendJson } = require("./http");
const { SAMPLING_PARAMETERS, providerOf, sortedCandidates } = require("./channels");
const { callProvider } = require("./providers");
const { responseFinishReason, responseText, usageErrorDetail } = require("./utils");
const {
  createOpenAIStreamErrorDetector,
  openAIStreamChunk,
  openAIStreamHeaders,
  sseChunk
} = require("./stream");

function applyParameterPass(channel, body) {
  const next = { ...body };
  const parameterPass = channel.parameterPass || {};
  for (const name of SAMPLING_PARAMETERS) {
    if (parameterPass[name] === false) delete next[name];
  }
  return next;
}

async function proxyChat(req, res, body) {
  const alias = body.model;
  if (!alias) return sendError(res, 400, "Missing model");
  const clientWantsStream = body.stream === true;
  const candidates = sortedCandidates(alias);
  if (!candidates.length) return sendError(res, 404, `No enabled channel found for model alias: ${alias}`);

  const errors = [];
  for (const { channel, model } of candidates) {
    const provider = providerOf(channel);
    try {
      const upstreamWantsStream = clientWantsStream && channel.stream !== false;
      const upstreamBody = applyParameterPass(channel, { ...body, stream: upstreamWantsStream });
      const upstream = await callProvider(provider, channel, model.id, alias, upstreamBody, req.url);
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
          usageRecord({ success: true, endpoint: req.url, bytes, model: alias, sourceModel: model.id, channelId: channel.id, channelNote: channel.note, provider });
        } catch (error) {
          const detail = usageErrorDetail(error, {
            channelId: channel.id,
            channelNote: channel.note,
            provider,
            upstreamStatus: upstream.status === 200 ? null : upstream.status
          });
          usageRecord({ success: false, endpoint: req.url, bytes, model: alias, sourceModel: model.id, ...detail, error: error.message });
          if (!res.destroyed && !res.writableEnded) {
            if (!streamErrorWritten) res.write(sseChunk(openAIStreamChunk(alias, `Stream error: ${error.message}`, "stop")));
            res.write(Buffer.from("data: [DONE]\n\n", "utf8"));
            res.end();
          }
        }
        return;
      }

      usageRecord({ success: true, endpoint: req.url, model: alias, sourceModel: model.id, channelId: channel.id, channelNote: channel.note, provider });
      if (clientWantsStream) {
        const id = `chatcmpl-${crypto.randomUUID()}`;
        const content = responseText(upstream.body);
        const contentChunk = sseChunk(openAIStreamChunk(alias, content, null, id));
        const finishChunk = sseChunk(openAIStreamChunk(alias, "", responseFinishReason(upstream.body), id));
        res.writeHead(upstream.status, openAIStreamHeaders());
        res.write(contentChunk);
        res.write(finishChunk);
        res.write(Buffer.from("data: [DONE]\n\n", "utf8"));
        return res.end();
      }
      return sendJson(res, upstream.status, upstream.body);
    } catch (error) {
      const detail = usageErrorDetail(error, {
        channelId: channel.id,
        channelNote: channel.note,
        provider
      });
      errors.push(detail);
      usageRecord({ success: false, endpoint: req.url, model: alias, sourceModel: model.id, ...detail, error: error.message });
    }
  }
  const firstError = errors[0] || {};
  sendError(res, 502, firstError.message || "All matching channels failed", {
    errors,
    upstreamStatus: firstError.upstreamStatus || null,
    upstreamBody: firstError.upstreamBody || null
  });
}

module.exports = {
  proxyChat
};
