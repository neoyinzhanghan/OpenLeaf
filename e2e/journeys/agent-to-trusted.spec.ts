/**
 * Journey 1 (MCP path): agent proposes sources/facts/knowledge; owner reviews to trusted.
 * Mirrors e2e/knowledge-web-source.spec.ts instance lifecycle (that one is stable).
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { startInstance, type Instance } from "../instance";

const afterDir = path.join(process.cwd(), "docs/knowledge/morning/agent-to-trusted/after");
fs.mkdirSync(afterDir, { recursive: true });

let instance: Instance;
let pageServer: http.Server;
let pageUrl = "";

test.beforeAll(async () => {
  process.env.OPENLEAF_ALLOW_PRIVATE_FETCH = "1";
  pageServer = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html><head><title>DEMO AUC Note</title></head>
      <body>
        <p>Model A reports an AUC of 0.91 on the held-out set.</p>
        <p>The accuracy on the same set is 0.84 and must not be used as the headline metric.</p>
      </body></html>`);
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

function structured<T>(body: unknown): T | undefined {
  return (body as { result?: { structuredContent?: T } })?.result?.structuredContent;
}

test("MCP research to trusted knowledge item", async ({ page }) => {
  const step = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
    try {
      // eslint-disable-next-line no-console
      console.log("STEP", label);
      return await fn();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("FAIL AT", label, e);
      throw e;
    }
  };

  // Three web sources via distinct URLs (dedupe is by URL).
  const sources: string[] = [];
  for (const [i, title] of [
    "DEMO AUC Note",
    "DEMO AUC Note B",
    "DEMO AUC Note C",
  ].entries()) {
    const add = await step(`source_add_web ${title}`, () =>
      mcp("source_add_web", {
        url: `${pageUrl}?n=${i}`,
        title,
        collection: "demo-agent-session",
      }),
    );
    expect(add.res.ok, JSON.stringify(add.body)).toBeTruthy();
    const ck = structured<{ citekey: string }>(add.body)?.citekey;
    expect(ck).toBeTruthy();
    sources.push(ck!);
  }
  expect(new Set(sources).size).toBe(3);
  const citekey = sources[0]!;

  const snap = await step("snapshot", async () =>
    (
      await fetch(`${instance.baseURL}/api/library/${encodeURIComponent(citekey)}/snapshot.txt`, {
        headers: { Origin: instance.baseURL },
      })
    ).text(),
  );
  const quote = "Model A reports an AUC of 0.91 on the held-out set.";
  const accQuote = "The accuracy on the same set is 0.84 and must not be used as the headline metric.";
  expect(snap).toContain(quote);

  const proposals = [
    { input: "DEMO model A AUC", answer: "0.91", key: "demo-model-a-auc", value: 0.91, quotes: [quote] },
    {
      input: "DEMO model A accuracy (not headline)",
      answer: "0.84",
      key: "demo-model-a-acc",
      value: 0.84,
      quotes: [accQuote],
    },
    { input: "DEMO AUC again from note B", answer: "0.91", key: "demo-model-a-auc-b", value: 0.91, quotes: [quote] },
  ];
  for (const [i, p] of proposals.entries()) {
    const proposed = await step(`fact_propose ${p.key}`, () =>
      mcp("fact_propose", {
        citekey: sources[Math.min(i, sources.length - 1)]!,
        type: "value",
        input: p.input,
        answer: p.answer,
        key: p.key,
        value: p.value,
        unit: "",
        quotes: p.quotes,
        agentName: "journey-agent",
      }),
    );
    expect(proposed.res.ok, JSON.stringify(proposed.body)).toBeTruthy();
    expect(structured<{ fact: { status: string } }>(proposed.body)?.fact.status).toBe("unreviewed");
  }

  const kn = await step("knowledge_create", () =>
    mcp("knowledge_create", {
      title: "DEMO headline AUC for Model A",
      knowledgeId: "demo-headline-auc",
    }),
  );
  expect(kn.res.ok).toBeTruthy();
  const projectId = structured<{ project?: { id: string } }>(kn.body)?.project?.id;
  expect(projectId, JSON.stringify(kn.body)).toBeTruthy();

  const put = await step("put main.tex", () =>
    fetch(`${instance.baseURL}/api/projects/${encodeURIComponent(projectId!)}/files/main.tex`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: instance.baseURL },
      body: JSON.stringify({
        content: `\\documentclass{article}
\\usepackage{openleaf-knowledge}
\\begin{document}
\\begin{knowledge}[result=auc]{DEMO headline AUC for Model A}
\\begin{assumption}[use-auc]
We report AUC, not accuracy.
\\end{assumption}
\\begin{calculation}{auc}
\\fact{demo-model-a-auc}
\\end{calculation}
\\begin{judgment}[headline]
AUC is the right headline metric for this DEMO.
\\end{judgment}
\\conclusion{Headline AUC is \\out{auc}.}
\\end{knowledge}
\\end{document}
`,
      }),
    }),
  );
  expect(put.ok).toBeTruthy();

  const inbox = await step("inbox", async () =>
    (
      await fetch(`${instance.baseURL}/api/knowledge/inbox`, { headers: { Origin: instance.baseURL } })
    ).json(),
  );
  expect(inbox.count).toBeGreaterThan(0);

  await step("goto review", async () => {
    await page.goto(`${instance.baseURL}/review`);
    await expect(page.getByRole("heading", { name: "Review", exact: true })).toBeVisible();
    await page.screenshot({ path: path.join(afterDir, "01-inbox-from-agent.png"), fullPage: true });
  });

  const facts = await step("list facts", async () =>
    (await fetch(`${instance.baseURL}/api/library/facts`, { headers: { Origin: instance.baseURL } })).json(),
  );
  const fact = (facts.facts as Array<{ id: string; citekey: string; key?: string }>).find(
    (f) => f.key === "demo-model-a-auc",
  );
  expect(fact).toBeTruthy();
  await step("confirm fact", () =>
    fetch(
      `${instance.baseURL}/api/library/${encodeURIComponent(fact!.citekey)}/facts/${encodeURIComponent(fact!.id)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Origin: instance.baseURL },
        body: JSON.stringify({ status: "confirmed", confirmWithContent: true }),
      },
    ),
  );

  for (const stepId of ["assumption:use-auc", "calculation:auc", "judgment:headline", "conclusion"]) {
    const rev = await step(`review ${stepId}`, () =>
      fetch(`${instance.baseURL}/api/projects/${encodeURIComponent(projectId!)}/knowledge/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: instance.baseURL },
        body: JSON.stringify({ stepId, verdict: "reviewed" }),
      }),
    );
    expect(rev.ok, `${stepId}: ${await rev.text()}`).toBeTruthy();
  }

  const stepsBody = (await step("steps", async () =>
    (
      await fetch(`${instance.baseURL}/api/projects/${encodeURIComponent(projectId!)}/knowledge/steps`, {
        headers: { Origin: instance.baseURL },
      })
    ).json(),
  )) as { steps: Array<{ status: string }> };
  expect(stepsBody.steps.every((s) => s.status === "reviewed")).toBeTruthy();

  await step("trusted trail UI", async () => {
    await page.goto(`${instance.baseURL}/p/${encodeURIComponent(projectId!)}?review=1`);
    const trailTab = page.locator('.pane-title-tabs [role="tab"]', { hasText: "Trail" });
    await expect(trailTab).toBeVisible({ timeout: 20_000 });
    if ((await trailTab.getAttribute("aria-selected")) !== "true") await trailTab.click();
    await expect(page.locator(".editor-kn-review-pane")).toBeVisible({ timeout: 10_000 });
    await page.screenshot({ path: path.join(afterDir, "02-trusted-trail.png"), fullPage: true });
  });
});
