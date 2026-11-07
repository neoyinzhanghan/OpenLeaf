/**
 * Journey 4: from a paper/knowledge number back to the source passage and home again.
 */
import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { startInstance, type Instance } from "../instance";

const afterDir = path.join(process.cwd(), "docs/knowledge/morning/trace-conclusion/after");
fs.mkdirSync(afterDir, { recursive: true });

let instance: Instance;

test.beforeAll(async () => {
  instance = await startInstance();
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
  if (r.status !== 0) throw new Error(`seed failed:\n${r.stdout}\n${r.stderr}`);
});

test.afterAll(async () => {
  await instance.stop();
});

test("trace from knowledge trail to fact passage and back", async ({ page }) => {
  const graph = (await (
    await fetch(`${instance.baseURL}/api/knowledge/graph`, { headers: { Origin: instance.baseURL } })
  ).json()) as {
    nodes: Array<{ id: string; kind: string; name: string; projectId?: string; pathRef?: string }>;
  };
  const kn = graph.nodes.find((n) => n.kind === "knowledge" && /market/i.test(n.name));
  expect(kn, "demo market knowledge present").toBeTruthy();

  const projectId =
    kn!.projectId ||
    (kn!.pathRef?.startsWith("projects/") ? kn!.pathRef.slice("projects/".length) : null) ||
    kn!.name;
  expect(projectId).toBeTruthy();

  await page.goto(`${instance.baseURL}/p/${encodeURIComponent(projectId)}?review=1`);
  const trailTab = page.locator('.pane-title-tabs [role="tab"]', { hasText: "Trail" });
  await expect(trailTab).toBeVisible({ timeout: 20_000 });
  if ((await trailTab.getAttribute("aria-selected")) !== "true") await trailTab.click();
  await expect(page.locator(".editor-kn-review-pane")).toBeVisible();
  await page.screenshot({ path: path.join(afterDir, "01-trail.png"), fullPage: true });

  const openFact = page.locator(".editor-kn-review-pane").getByRole("link").first();
  if (await openFact.count()) {
    await openFact.click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(afterDir, "02-fact-or-source.png"), fullPage: true });
  }

  await page.goto(`${instance.baseURL}/p/${encodeURIComponent(projectId)}?review=1`);
  await expect(trailTab).toBeVisible({ timeout: 20_000 });
  await page.screenshot({ path: path.join(afterDir, "03-back-to-writeup.png"), fullPage: true });
});
