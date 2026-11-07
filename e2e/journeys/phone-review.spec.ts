/**
 * Journey 7: confirm / reject a fact at 390px phone width.
 */
import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { startInstance, type Instance } from "../instance";

const afterDir = path.join(process.cwd(), "docs/knowledge/morning/phone/after");
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

test("phone width: review inbox and confirm a fact", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${instance.baseURL}/review`);
  await expect(page.getByRole("heading", { name: "Review" })).toBeVisible();
  await page.screenshot({ path: path.join(afterDir, "01-inbox-390.png"), fullPage: true });

  const seePassage = page.getByRole("link", { name: /See passage/i }).first();
  if (await seePassage.count()) {
    await seePassage.click();
    await expect(page).toHaveURL(/\/facts/);
    await page.screenshot({ path: path.join(afterDir, "02-facts-390.png"), fullPage: true });
    const confirm = page.getByRole("button", { name: /^Confirm$/i }).first();
    if (await confirm.isEnabled()) {
      await confirm.click();
    }
  }
});
