/**
 * Journey 5: no agent — add a web page by URL, tag a fact, open knowledge by hand.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { startInstance, type Instance } from "../instance";

const afterDir = path.join(process.cwd(), "docs/knowledge/morning/no-agent/after");
fs.mkdirSync(afterDir, { recursive: true });

let instance: Instance;
let pageServer: http.Server;
let pageUrl = "";

test.beforeAll(async () => {
  process.env.OPENLEAF_ALLOW_PRIVATE_FETCH = "1";
  pageServer = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html><head><title>DEMO Manual Fee</title></head>
      <body><p>The fee per read is exactly 412.5 USD in this demo page.</p></body></html>`);
  });
  await new Promise<void>((r) => pageServer.listen(0, "127.0.0.1", () => r()));
  pageUrl = `http://127.0.0.1:${(pageServer.address() as { port: number }).port}/`;
  instance = await startInstance();
});

test.afterAll(async () => {
  await instance.stop();
  await new Promise<void>((r) => pageServer.close(() => r()));
});

test("manual web import, fact, and knowledge without MCP", async ({ page }) => {
  const add = await fetch(`${instance.baseURL}/api/library/import/web`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: instance.baseURL },
    body: JSON.stringify({ url: pageUrl }),
  });
  expect(add.ok).toBeTruthy();
  const body = (await add.json()) as { paper: { citekey: string; title: string; source: string } };
  expect(body.paper.source).toBe("web");
  expect(body.paper.title).toMatch(/DEMO Manual Fee/i);

  const snapRes = await fetch(
    `${instance.baseURL}/api/library/${encodeURIComponent(body.paper.citekey)}/snapshot.txt`,
    { headers: { Origin: instance.baseURL } },
  );
  expect(snapRes.ok).toBeTruthy();
  const snap = await snapRes.text();
  const quote = "The fee per read is exactly 412.5 USD in this demo page.";
  expect(snap).toContain("412.5");

  const create = await fetch(
    `${instance.baseURL}/api/library/${encodeURIComponent(body.paper.citekey)}/facts`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: instance.baseURL },
      body: JSON.stringify({
        type: "value",
        input: "Fee per read",
        answer: "412.5",
        key: "demo-manual-fee",
        highlights: [
          {
            page: 1,
            start: Math.max(0, snap.indexOf(quote)),
            end: Math.max(quote.length, snap.indexOf(quote) + quote.length),
            quote,
          },
        ],
      }),
    },
  );
  expect(create.status).toBe(201);
  const factBody = (await create.json()) as { fact: { status: string; key?: string; value?: number } };
  expect(factBody.fact.status).toBe("confirmed");
  expect(factBody.fact.value).toBe(412.5);

  await page.goto(`${instance.baseURL}/library`);
  await expect(page.getByText(/DEMO Manual Fee|Web page|Web snapshot/i).first()).toBeVisible({
    timeout: 20_000,
  });
  await page.screenshot({ path: path.join(afterDir, "01-library-web.png"), fullPage: true });

  await page.goto(
    `${instance.baseURL}/facts?paper=${encodeURIComponent(body.paper.citekey)}&status=all&type=all`,
  );
  await page.screenshot({ path: path.join(afterDir, "02-facts-manual.png"), fullPage: true });

  // Create a knowledge project the host way (REST), then open Trail.
  const projects = (await (
    await fetch(`${instance.baseURL}/api/projects`, { headers: { Origin: instance.baseURL } })
  ).json()) as { projects?: Array<{ id: string }> };
  const createKn = await fetch(`${instance.baseURL}/api/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: instance.baseURL },
    body: JSON.stringify({ name: "DEMO manual fee knowledge" }),
  });
  if (createKn.ok) {
    const created = (await createKn.json()) as { project?: { id: string }; id?: string };
    const projectId = created.project?.id || created.id;
    if (projectId) {
      await fetch(`${instance.baseURL}/api/projects/${encodeURIComponent(projectId)}/files/openleaf.json`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Origin: instance.baseURL },
        body: JSON.stringify({
          content: JSON.stringify(
            {
              name: "DEMO manual fee knowledge",
              mainFile: "main.tex",
              engine: "pdflatex",
              kind: "knowledge",
              knowledgeId: "demo-manual-fee-kn",
            },
            null,
            2,
          ),
        }),
      });
      await fetch(`${instance.baseURL}/api/projects/${encodeURIComponent(projectId)}/files/main.tex`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Origin: instance.baseURL },
        body: JSON.stringify({
          content: `\\documentclass{article}
\\usepackage{openleaf-knowledge}
\\begin{document}
\\begin{knowledge}[result=fee]{DEMO manual fee knowledge}
\\begin{calculation}{fee}
\\fact{demo-manual-fee}
\\end{calculation}
\\conclusion{Fee is \\out{fee}.}
\\end{knowledge}
\\end{document}
`,
        }),
      });
      await page.goto(`${instance.baseURL}/p/${encodeURIComponent(projectId)}?review=1`);
      await page.screenshot({ path: path.join(afterDir, "03-manual-knowledge.png"), fullPage: true });
    }
  }
  void projects;
});
