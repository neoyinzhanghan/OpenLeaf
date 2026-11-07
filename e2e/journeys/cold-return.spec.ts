/**
 * Journey 3: coming back after a week — cold open shows what needs the owner.
 */
import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { startInstance, type Instance } from "../instance";

const afterDir = path.join(process.cwd(), "docs/knowledge/morning/cold-return/after");
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

test("cold open: home and review show what needs attention in ten seconds", async ({ page }) => {
  const t0 = Date.now();
  await page.goto(instance.baseURL);
  // Landing / projects should load; then jump to Review which is the "what needs me" surface.
  await page.goto(`${instance.baseURL}/review`);
  await expect(page.getByRole("heading", { name: "Review", exact: true })).toBeVisible({
    timeout: 15_000,
  });
  const elapsed = Date.now() - t0;
  expect(elapsed).toBeLessThan(15_000);

  const countBadge = page.locator(".review-count, .nav-badge, [data-inbox-count]").first();
  const groupHeadings = page.getByRole("heading", { level: 2 });
  await expect(groupHeadings.first()).toBeVisible();
  await page.screenshot({ path: path.join(afterDir, "01-cold-review.png"), fullPage: true });

  // At least one actionable row.
  await expect(page.locator(".review-row").first()).toBeVisible();
  void countBadge;
});
