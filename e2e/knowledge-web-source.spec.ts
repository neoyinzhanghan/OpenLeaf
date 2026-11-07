import http from "node:http";
import { expect, test } from "@playwright/test";
import { startInstance, type Instance } from "./instance";

let instance: Instance;
let pageServer: http.Server;
let pageUrl = "";

test.beforeAll(async () => {
  process.env.OPENLEAF_ALLOW_PRIVATE_FETCH = "1";
  pageServer = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html><head><title>DEMO Market Note</title></head>
      <body><p>The fee per read is exactly 412.5 USD in this demo page.</p></body></html>`);
  });
  await new Promise<void>((resolve) => {
    pageServer.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = pageServer.address();
  if (!addr || typeof addr === "string") throw new Error("no page port");
  pageUrl = `http://127.0.0.1:${addr.port}/`;

  instance = await startInstance();
});

test.afterAll(async () => {
  await instance.stop();
  await new Promise<void>((resolve, reject) =>
    pageServer.close((e) => (e ? reject(e) : resolve())),
  );
});

test("add a web page and confirm a fact on its snapshot text", async ({ page }) => {
  // Direct API path (mirrors Library "Add web page") so the e2e stays focused.
  const add = await fetch(`${instance.baseURL}/api/library/import/web`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: instance.baseURL },
    body: JSON.stringify({ url: pageUrl }),
  });
  expect(add.ok).toBeTruthy();
  const body = (await add.json()) as { paper: { citekey: string; title: string; source: string } };
  expect(body.paper.source).toBe("web");
  expect(body.paper.title).toMatch(/DEMO Market Note/i);

  const snap = await fetch(
    `${instance.baseURL}/api/library/${encodeURIComponent(body.paper.citekey)}/snapshot.txt`,
    { headers: { Origin: instance.baseURL } },
  );
  expect(snap.ok).toBeTruthy();
  expect(snap.headers.get("content-type") ?? "").toMatch(/text\/plain/);
  const text = await snap.text();
  expect(text).toMatch(/412\.5/);

  const quote = "The fee per read is exactly 412.5 USD in this demo page.";
  const create = await fetch(
    `${instance.baseURL}/api/library/${encodeURIComponent(body.paper.citekey)}/facts`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: instance.baseURL },
      body: JSON.stringify({
        type: "value",
        input: "Fee per read",
        answer: "412.5",
        highlights: [{ page: 1, start: text.indexOf(quote), end: text.indexOf(quote) + quote.length, quote }],
      }),
    },
  );
  expect(create.status).toBe(201);
  const factBody = (await create.json()) as {
    fact: { key?: string; value?: number; status: string; sourceKind?: string };
  };
  expect(factBody.fact.status).toBe("confirmed");
  expect(factBody.fact.sourceKind).toBe("web");
  expect(factBody.fact.value).toBe(412.5);
  expect(factBody.fact.key).toBeTruthy();

  await page.goto(`${instance.baseURL}/facts?paper=${encodeURIComponent(body.paper.citekey)}`);
  await page.getByRole("tab", { name: /Confirmed/i }).click();
  await expect(page.locator(".library-facts-key-chip").first()).toBeVisible({ timeout: 20_000 });
});
