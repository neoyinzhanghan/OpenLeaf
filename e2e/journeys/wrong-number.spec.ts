/**
 * Journey 2: wrong number — reject, see impact, replace, re-review until clean.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { startInstance, type Instance } from "../instance";

const afterDir = path.join(process.cwd(), "docs/knowledge/morning/wrong-number/after");
fs.mkdirSync(afterDir, { recursive: true });

let instance: Instance;
let pageServer: http.Server;
let pageUrl = "";

test.beforeAll(async () => {
  process.env.OPENLEAF_ALLOW_PRIVATE_FETCH = "1";
  pageServer = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html><head><title>DEMO Metric Note</title></head>
      <body>
        <p>Model A reports an AUC of 0.91 on the held-out set.</p>
        <p>The accuracy on the same set is 0.84 and must not be used as the headline metric.</p>
      </body></html>`);
  });
  await new Promise<void>((r) => pageServer.listen(0, "127.0.0.1", () => r()));
  pageUrl = `http://127.0.0.1:${(pageServer.address() as { port: number }).port}/`;
  instance = await startInstance();
});

test.afterAll(async () => {
  await instance.stop();
  await new Promise<void>((r) => pageServer.close(() => r()));
});

async function mcp(name: string, args: Record<string, unknown>) {
  const res = await fetch(`${instance.baseURL}/api/library/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: instance.baseURL },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  return { res, body: await res.json() };
}
const sc = <T,>(body: unknown) =>
  (body as { result?: { structuredContent?: T } })?.result?.structuredContent;

test("reject wrong accuracy fact, replace with AUC, paper cleans", async ({ page }) => {
  const add = await mcp("source_add_web", {
    url: pageUrl,
    title: "DEMO Metric Note",
    collection: "wrong-number",
  });
  const citekey = sc<{ citekey: string }>(add.body)!.citekey;
  const badQuote = "The accuracy on the same set is 0.84 and must not be used as the headline metric.";
  const goodQuote = "Model A reports an AUC of 0.91 on the held-out set.";

  await mcp("fact_propose", {
    citekey,
    type: "value",
    input: "DEMO model A headline (wrong)",
    answer: "0.84",
    key: "demo-model-a-headline",
    value: 0.84,
    unit: "",
    quotes: [badQuote],
    agentName: "journey-agent",
  });

  const kn = await mcp("knowledge_create", {
    title: "DEMO headline metric",
    knowledgeId: "demo-headline-metric",
  });
  const projectId = sc<{ project: { id: string } }>(kn.body)!.project.id;
  await fetch(`${instance.baseURL}/api/projects/${encodeURIComponent(projectId)}/files/main.tex`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Origin: instance.baseURL },
    body: JSON.stringify({
      content: `\\documentclass{article}
\\usepackage{openleaf-knowledge}
\\begin{document}
\\begin{knowledge}[result=headline]{DEMO headline metric}
\\begin{calculation}{headline}
\\fact{demo-model-a-headline}
\\end{calculation}
\\conclusion{Headline is \\out{headline}.}
\\end{knowledge}
\\end{document}
`,
    }),
  });

  // Confirm the wrong fact so the step can be reviewed, then reject it.
  const facts = (await (
    await fetch(`${instance.baseURL}/api/library/facts`, { headers: { Origin: instance.baseURL } })
  ).json()) as { facts: Array<{ id: string; citekey: string; key?: string }> };
  const bad = facts.facts.find((f) => f.key === "demo-model-a-headline")!;
  await fetch(
    `${instance.baseURL}/api/library/${encodeURIComponent(bad.citekey)}/facts/${encodeURIComponent(bad.id)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Origin: instance.baseURL },
      body: JSON.stringify({ status: "confirmed", confirmWithContent: true }),
    },
  );
  await fetch(`${instance.baseURL}/api/projects/${encodeURIComponent(projectId)}/knowledge/review`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: instance.baseURL },
    body: JSON.stringify({ stepId: "calculation:headline", verdict: "reviewed" }),
  });
  await fetch(`${instance.baseURL}/api/projects/${encodeURIComponent(projectId)}/knowledge/review`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: instance.baseURL },
    body: JSON.stringify({ stepId: "conclusion", verdict: "reviewed" }),
  });

  // Now discover it is wrong — reject with reason.
  await fetch(
    `${instance.baseURL}/api/library/${encodeURIComponent(bad.citekey)}/facts/${encodeURIComponent(bad.id)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Origin: instance.baseURL },
      body: JSON.stringify({
        status: "rejected",
        rejectReason: "Agent used accuracy (0.84) instead of AUC (0.91)",
      }),
    },
  );

  const graph = (await (
    await fetch(`${instance.baseURL}/api/knowledge/graph`, { headers: { Origin: instance.baseURL } })
  ).json()) as { nodes: Array<{ id: string; status: string; why: string[] }> };
  const knNode = graph.nodes.find((n) => n.id === "kn:demo-headline-metric");
  expect(knNode?.status).not.toBe("up-to-date");
  expect(knNode?.why?.join(" ") ?? "").toMatch(/reject|accuracy|0\.84|unchecked|fact/i);

  await page.goto(`${instance.baseURL}/facts?paper=${encodeURIComponent(citekey)}`);
  await expect(page.getByText(/reject|impact|affect/i).first()).toBeVisible({ timeout: 20_000 });
  await page.screenshot({ path: path.join(afterDir, "01-reject-impact.png"), fullPage: true });

  // Replace: propose the correct AUC fact with the same key (or new key + edit tex).
  await mcp("fact_propose", {
    citekey,
    type: "value",
    input: "DEMO model A AUC",
    answer: "0.91",
    key: "demo-model-a-auc-correct",
    value: 0.91,
    unit: "",
    quotes: [goodQuote],
    agentName: "journey-agent",
  });
  // Point the knowledge item at the correct fact key.
  await fetch(`${instance.baseURL}/api/projects/${encodeURIComponent(projectId)}/files/main.tex`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Origin: instance.baseURL },
    body: JSON.stringify({
      content: `\\documentclass{article}
\\usepackage{openleaf-knowledge}
\\begin{document}
\\begin{knowledge}[result=headline]{DEMO headline metric}
\\begin{calculation}{headline}
\\fact{demo-model-a-auc-correct}
\\end{calculation}
\\conclusion{Headline is \\out{headline}.}
\\end{knowledge}
\\end{document}
`,
    }),
  });

  const facts2 = (await (
    await fetch(`${instance.baseURL}/api/library/facts`, { headers: { Origin: instance.baseURL } })
  ).json()) as { facts: Array<{ id: string; citekey: string; key?: string }> };
  const good = facts2.facts.find((f) => f.key === "demo-model-a-auc-correct")!;
  await fetch(
    `${instance.baseURL}/api/library/${encodeURIComponent(good.citekey)}/facts/${encodeURIComponent(good.id)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Origin: instance.baseURL },
      body: JSON.stringify({ status: "confirmed", confirmWithContent: true }),
    },
  );

  for (const stepId of ["calculation:headline", "conclusion"]) {
    const rev = await fetch(
      `${instance.baseURL}/api/projects/${encodeURIComponent(projectId)}/knowledge/review`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: instance.baseURL },
        body: JSON.stringify({ stepId, verdict: "reviewed" }),
      },
    );
    expect(rev.ok, await rev.text()).toBeTruthy();
  }

  const graph2 = (await (
    await fetch(`${instance.baseURL}/api/knowledge/graph`, { headers: { Origin: instance.baseURL } })
  ).json()) as { nodes: Array<{ id: string; status: string; why: string[] }> };
  const knClean = graph2.nodes.find((n) => n.id === "kn:demo-headline-metric");
  // Knowledge items use reviewed/flagged (papers use up-to-date).
  expect(knClean?.status).toBe("reviewed");
  expect(knClean?.why ?? []).toEqual([]);

  await page.goto(`${instance.baseURL}/p/${encodeURIComponent(projectId)}?review=1`);
  const trailTab = page.locator('.pane-title-tabs [role="tab"]', { hasText: "Trail" });
  await expect(trailTab).toBeVisible({ timeout: 20_000 });
  if ((await trailTab.getAttribute("aria-selected")) !== "true") await trailTab.click();
  await expect(page.locator(".editor-kn-review-pane")).toBeVisible();
  await page.screenshot({ path: path.join(afterDir, "02-clean-after-replace.png"), fullPage: true });
});
