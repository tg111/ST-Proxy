const { usageRecord } = require("./state");
const { sendError, sendJson } = require("./http");
const { sortedCandidates } = require("./channels");
const { callResponses } = require("./providers");
const { usageErrorDetail } = require("./utils");

async function proxyResponses(req, res, body) {
  const alias = body.model;
  if (!alias) return sendError(res, 400, "Missing model");
  const candidates = sortedCandidates(alias);
  if (!candidates.length) return sendError(res, 404, `No enabled channel found for model alias: ${alias}`);

  const errors = [];
  for (const { channel, model } of candidates) {
    try {
      const upstream = await callResponses(channel, model.id, body);
      if (upstream.stream) {
        res.writeHead(upstream.status, upstream.headers);
        let bytes = 0;
        try {
          for await (const chunk of upstream.body) {
            bytes += chunk.length;
            res.write(chunk);
          }
          res.end();
          usageRecord({ success: true, endpoint: req.url, bytes, model: alias, sourceModel: model.id, channelId: channel.id, channelNote: channel.note });
        } catch (error) {
          usageRecord({ success: false, endpoint: req.url, bytes, model: alias, sourceModel: model.id, channelId: channel.id, channelNote: channel.note, error: error.message });
          if (!res.destroyed && !res.writableEnded) res.end();
        }
        return;
      }

      usageRecord({ success: true, endpoint: req.url, model: alias, sourceModel: model.id, channelId: channel.id, channelNote: channel.note });
      return sendJson(res, upstream.status, upstream.body);
    } catch (error) {
      const detail = usageErrorDetail(error, {
        channelId: channel.id,
        channelNote: channel.note
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
  proxyResponses
};
