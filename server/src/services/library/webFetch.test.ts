import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, it } from "node:test";
import {
  allowPrivateFetch,
  assertSafeUrl,
  fetchWebPage,
  isPrivateOrLocalIp,
} from "./webFetch.js";
import { extractTitleFromHtml, htmlToReadableText } from "./webText.js";

describe("webFetch safety", () => {
  it("detects private and loopback addresses", () => {
    assert.equal(isPrivateOrLocalIp("127.0.0.1"), true);
    assert.equal(isPrivateOrLocalIp("10.0.0.1"), true);
    assert.equal(isPrivateOrLocalIp("192.168.1.1"), true);
    assert.equal(isPrivateOrLocalIp("172.16.5.5"), true);
    assert.equal(isPrivateOrLocalIp("169.254.1.1"), true);
    assert.equal(isPrivateOrLocalIp("8.8.8.8"), false);
    assert.equal(isPrivateOrLocalIp("::1"), true);
  });

  it("refuses non-http schemes", async () => {
    await assert.rejects(() => assertSafeUrl("file:///etc/passwd"), /http/);
    await assert.rejects(() => assertSafeUrl("ftp://example.com/x"), /http/);
  });

  it("refuses private IPs unless allow flag is set", async () => {
    const prev = process.env.OPENLEAF_ALLOW_PRIVATE_FETCH;
    delete process.env.OPENLEAF_ALLOW_PRIVATE_FETCH;
    assert.equal(allowPrivateFetch(), false);
    await assert.rejects(() => assertSafeUrl("http://127.0.0.1/"), /private|local/i);
    process.env.OPENLEAF_ALLOW_PRIVATE_FETCH = "1";
    const ok = await assertSafeUrl("http://127.0.0.1/");
    assert.equal(ok.hostname, "127.0.0.1");
    if (prev === undefined) delete process.env.OPENLEAF_ALLOW_PRIVATE_FETCH;
    else process.env.OPENLEAF_ALLOW_PRIVATE_FETCH = prev;
  });
});

describe("htmlToReadableText", () => {
  it("strips scripts and extracts title + body text", () => {
    const html = `<html><head><title> Market Size </title>
      <script>evil()</script><style>.x{}</style></head>
      <body><nav>skip</nav><p>Hello &amp; welcome</p><p>Fee is $412.5</p></body></html>`;
    assert.equal(extractTitleFromHtml(html), "Market Size");
    const text = htmlToReadableText(html);
    assert.match(text, /Hello & welcome/);
    assert.match(text, /Fee is \$412\.5/);
    assert.doesNotMatch(text, /evil|skip|\.x/);
  });
});

describe("fetchWebPage with local server", () => {
  let server: http.Server;
  let base = "";

  before(async () => {
    process.env.OPENLEAF_ALLOW_PRIVATE_FETCH = "1";
    server = http.createServer((req, res) => {
      if (req.url === "/hop1") {
        res.writeHead(302, { Location: "/hop2" });
        res.end();
        return;
      }
      if (req.url === "/hop2") {
        res.writeHead(302, { Location: "/final" });
        res.end();
        return;
      }
      if (req.url === "/final") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<html><title>Final</title><body><p>Landed</p></body></html>");
        return;
      }
      if (req.url === "/huge") {
        res.writeHead(200, { "Content-Type": "text/plain", "Content-Length": "100" });
        res.end("x".repeat(100));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no port");
    base = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  });

  it("follows redirects and re-checks each hop", async () => {
    const page = await fetchWebPage(`${base}/hop1`);
    assert.match(page.finalUrl, /\/final$/);
    assert.match(page.body.toString("utf8"), /Landed/);
  });

  it("enforces the size cap", async () => {
    await assert.rejects(
      () => fetchWebPage(`${base}/huge`, { maxBytes: 50 }),
      /exceeded|limit/i,
    );
  });
});
