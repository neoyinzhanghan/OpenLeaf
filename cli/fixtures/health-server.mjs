import http from "node:http";

const port = Number(process.env.OPENLEAF_PORT || 8787);
const host = process.env.OPENLEAF_HOST || "127.0.0.1";

const server = http.createServer((req, res) => {
  if ((req.url ?? "").startsWith("/api/health")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, name: "openleaf" }));
    return;
  }
  res.writeHead(200, { "content-type": "text/html" });
  res.end("<!doctype html><title>OpenLeaf</title>");
});

server.listen(port, host);
