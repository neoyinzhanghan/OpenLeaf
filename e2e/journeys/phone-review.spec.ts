/**
 * Journey 7: confirm a fact at 390px phone width.
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
  await expect(page.getByRole("heading", { name: "Review", exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(afterDir, "01-inbox-390.png"), fullPage: true });

  const seePassage = page.getByRole("link", { name: /See passage/i }).first();
  await expect(seePassage).toBeVisible({ timeout: 15_000 });
  await seePassage.click();
  await expect(page).toHaveURL(/\/facts/);
  await page.screenshot({ path: path.join(afterDir, "02-facts-390.png"), fullPage: true });

  await page.goto(`${instance.baseURL}/review`);
  await expect(page.getByRole("heading", { name: "Review", exact: true })).toBeVisible();
  const confirm = page.getByRole("button", { name: /^Confirm$/i }).first();
  await expect(confirm).toBeVisible({ timeout: 15_000 });
  await confirm.click();
  await page.screenshot({ path: path.join(afterDir, "03-inbox-after-confirm-390.png"), fullPage: true });

  // Reject via API at phone viewport still exercises the impact UI if a fact remains.
  const inbox = (await (
    await fetch(`${instance.baseURL}/api/knowledge/inbox`, { headers: { Origin: instance.baseURL } })
  ).json()) as {
    groups: Array<{ items: Array<{ type: string; citekey?: string; factId?: string }> }>;
  };
  const fact = inbox.groups.flatMap((g) => g.items).find((i) => i.type === "fact" && i.citekey && i.factId);
  if (fact?.citekey && fact.factId) {
    await fetch(
      `${instance.baseURL}/api/library/${encodeURIComponent(fact.citekey)}/facts/${encodeURIComponent(fact.factId)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Origin: instance.baseURL },
        body: JSON.stringify({
          status: "rejected",
          rejectReason: "Phone journey: wrong number",
        }),
      },
    );
    await page.goto(`${instance.baseURL}/review`);
    await page.screenshot({ path: path.join(afterDir, "04-after-reject-390.png"), fullPage: true });
  }
});
