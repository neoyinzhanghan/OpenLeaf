/**
 * Coming back / inbox clarity: seed demo, open cold, confirm counts agree,
 * open a knowledge item Trail without covering the write-up.
 */
import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { startInstance, type Instance } from "../instance";

const afterDir = path.join(process.cwd(), "docs/knowledge/morning/inbox-trail/after");
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

async function api(p: string, init?: RequestInit) {
  const res = await fetch(`${instance.baseURL}${p}`, {
    ...init,
    headers: { Origin: instance.baseURL, "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  return { res, body: await res.json().catch(() => null) };
}

test("cold open: inbox count matches and trail stays in the sidebar", async ({ page }) => {
  const inbox = await api("/api/knowledge/inbox");
  expect(inbox.res.ok).toBeTruthy();
  const body = inbox.body as { count: number; groups: Array<{ items: unknown[] }> };
  expect(body.count).toBe(body.groups.reduce((n, g) => n + g.items.length, 0));
  expect(body.count).toBeGreaterThan(0);

  await page.goto(`${instance.baseURL}/review`);
  await expect(page.getByRole("heading", { name: "Review" })).toBeVisible();
  const badge = page.locator(".nav-badge").first();
  if (await badge.count()) {
    await expect(badge).toHaveText(String(body.count));
  }
  await page.screenshot({ path: path.join(afterDir, "01-inbox-cold.png"), fullPage: true });

  // Open market knowledge write-up with review=1 — Trail tab, write-up still there.
  const items = await api("/api/knowledge/items");
  expect(items.res.ok).toBeTruthy();
  const list = (items.body as { items: Array<{ id: string; title: string; knowledgeId: string }> }).items;
  const market = list.find((p) => /market size/i.test(p.title) || p.knowledgeId === "demo-us-market-size");
  expect(market).toBeTruthy();
  await page.goto(`${instance.baseURL}/p/${encodeURIComponent(market!.id)}?review=1`);
  // Wait for knowledge mode to load (tabs only appear once openleaf.json is read).
  const trailTab = page.locator('.pane-title-tabs [role="tab"]', { hasText: "Trail" });
  await expect(trailTab).toBeVisible({ timeout: 20_000 });
  // If Files is still selected (race before review effect), click Trail.
  if ((await trailTab.getAttribute("aria-selected")) !== "true") {
    await trailTab.click();
  }
  await expect(trailTab).toHaveAttribute("aria-selected", "true");
  // Write-up editor / PDF pane still present — no floating overlay covering it.
  await expect(page.locator(".editor-kn-review-rail")).toHaveCount(0);
  await expect(page.locator(".editor-kn-review-pane")).toBeVisible();
  await expect(page.getByRole("button", { name: /Back to write-up/i })).toHaveCount(0);
  await page.screenshot({ path: path.join(afterDir, "02-trail-in-sidebar.png"), fullPage: true });
});
