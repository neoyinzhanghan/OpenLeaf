/**
 * Journey 2 slice: reject a fact → every downstream screen tells the truth.
 * Screenshots land in docs/knowledge/morning/truth-reject/{before,after}/.
 */
import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { startInstance, type Instance } from "../instance";

const shotRoot = path.join(process.cwd(), "docs/knowledge/morning/truth-reject");
const afterDir = path.join(shotRoot, "after");
fs.mkdirSync(afterDir, { recursive: true });

let instance: Instance;

test.beforeAll(async () => {
  instance = await startInstance();
  // Seed demo into the sandbox.
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync("npx", ["tsx", "scripts/seed-knowledge-demo.mts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      OPENLEAF_PROJECTS_ROOT: instance.projects,
      OPENLEAF_LIBRARY_ROOT: path.join(path.dirname(instance.projects), "library"),
      OPENLEAF_CONFIG_DIR: path.join(path.dirname(instance.projects), "config"),
      OPENLEAF_HOST_GATEWAY: "0",
    },
    encoding: "utf8",
  });
  if (r.status !== 0) {
    throw new Error(`seed failed:\n${r.stdout}\n${r.stderr}`);
  }
});

test.afterAll(async () => {
  await instance.stop();
});

async function api(p: string, init?: RequestInit) {
  const res = await fetch(`${instance.baseURL}${p}`, {
    ...init,
    headers: {
      Origin: instance.baseURL,
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { res, body };
}

test("rejecting a fee fact flags knowledge and paper with why", async ({ page }) => {
  // Locate the demo fee fact.
  const facts = await api("/api/library/facts");
  if (!facts.res.ok) {
    throw new Error(`facts list failed ${facts.res.status}: ${JSON.stringify(facts.body)}`);
  }
  const fee = (
    facts.body as { facts: Array<{ id: string; citekey: string; key?: string; status: string }> }
  ).facts.find((f) => f.key === "demo-fee-per-read");
  expect(fee, `demo-fee-per-read missing; got ${JSON.stringify((facts.body as { facts: unknown[] }).facts?.map((f: { key?: string }) => f.key))}`).toBeTruthy();

  // Confirm it first if needed, then reject with a reason.
  if (fee!.status !== "confirmed") {
    await api(`/api/library/${encodeURIComponent(fee!.citekey)}/facts/${encodeURIComponent(fee!.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "confirmed", confirmWithContent: true }),
    });
  }
  const rejected = await api(
    `/api/library/${encodeURIComponent(fee!.citekey)}/facts/${encodeURIComponent(fee!.id)}`,
    {
      method: "PATCH",
      body: JSON.stringify({
        status: "rejected",
        rejectReason: "Wrong metric — accuracy instead of AUC (journey test)",
      }),
    },
  );
  expect(rejected.res.ok).toBeTruthy();

  const graph = await api("/api/knowledge/graph");
  expect(graph.res.ok).toBeTruthy();
  const nodes = (graph.body as { nodes: Array<{ id: string; status: string; why: string[] }> }).nodes;
  const kn = nodes.find((n) => n.id === "kn:demo-us-market-size");
  expect(kn).toBeTruthy();
  expect(kn!.status === "needs-review" || kn!.status === "flagged").toBeTruthy();
  expect(kn!.why.some((w) => /demo-fee-per-read.*rejected|rejected/.test(w))).toBeTruthy();

  const paper = nodes.find((n) => n.id.startsWith("proj:") && /demo-paper/i.test(n.id));
  expect(paper).toBeTruthy();
  expect(paper!.status).toBe("flagged");
  expect(paper!.why.length).toBeGreaterThan(0);

  const inbox = await api("/api/knowledge/inbox");
  expect(inbox.res.ok).toBeTruthy();
  const inboxBody = inbox.body as {
    count: number;
    groups: Array<{ title: string; items: Array<{ id: string; status: string }> }>;
  };
  expect(inboxBody.count).toBeGreaterThan(0);
  const flat = inboxBody.groups.flatMap((g) => g.items);
  expect(
    flat.some((i) => i.status === "rejected" && /demo-fee|fee|rejected/i.test(`${i.id} ${(i as { label?: string }).label ?? ""}`)),
  ).toBeTruthy();
  expect(flat.some((i) => (i as { type?: string }).type === "step")).toBeTruthy();

  await page.goto(`${instance.baseURL}/review`);
  await expect(page.getByRole("heading", { name: "Review", exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(afterDir, "01-inbox-after-reject.png"), fullPage: true });

  await page.goto(
    `${instance.baseURL}/facts?paper=${encodeURIComponent(fee!.citekey)}&fact=${encodeURIComponent(fee!.id)}&status=all&type=all`,
  );
  await expect(page.getByText(/Wrong metric|Rejected/i).first()).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: path.join(afterDir, "02-facts-rejected.png"), fullPage: true });

  await page.goto(`${instance.baseURL}/knowledge`);
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(afterDir, "03-tree-after-reject.png"), fullPage: true });
});
