const { URL } = require("url");
const { aliases } = require("./channels");
const { readBody, requireAuth, sendError, sendJson, staticFile } = require("./http");
const { api } = require("./api");
const { proxyChat } = require("./proxy");

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

module.exports = {
  route
};
