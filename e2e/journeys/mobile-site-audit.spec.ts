/**
 * Site-wide mobile audit at 390×844: overflow, crushed controls, missing chrome.
 * Screenshots land in docs/knowledge/morning/mobile-audit/after/.
 */
import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { startInstance, type Instance } from "../instance";

const afterDir = path.join(process.cwd(), "docs/knowledge/morning/mobile-audit/after");
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

async function audit(page: Page, label: string): Promise<string[]> {
  await page.setViewportSize({ width: 390, height: 844 });
  const issues = await page.evaluate(() => {
    const out: string[] = [];
    const root = document.documentElement;
    if (root.scrollWidth > root.clientWidth + 2) {
      out.push(`overflow ${root.scrollWidth}>${root.clientWidth}`);
    }
    const body = document.body;
    if (body.scrollWidth > body.clientWidth + 2) {
      out.push(`body overflow ${body.scrollWidth}>${body.clientWidth}`);
    }
    // Fixed/sticky bars that cover content bottom without padding
    const tabbar = document.querySelector(".phone-tabbar") as HTMLElement | null;
    if (tabbar) {
      const style = getComputedStyle(tabbar);
      if (style.display !== "none") {
        const box = tabbar.getBoundingClientRect();
        if (box.height > 0 && box.bottom > window.innerHeight + 1) {
          out.push("phone-tabbar clipped below viewport");
        }
        // Duplicate primary nav wastes vertical space on phones.
        const topNav = document.querySelector(".topbar-nav") as HTMLElement | null;
        if (topNav && getComputedStyle(topNav).display !== "none") {
          out.push("topbar-nav still visible with phone-tabbar");
        }
      }
    }
    // Pairing promo is a desktop→phone flow.
    const phonePromo = document.querySelector(".host-gateway-card:not(.is-remote)") as HTMLElement | null;
    if (phonePromo && getComputedStyle(phonePromo).display !== "none") {
      const box = phonePromo.getBoundingClientRect();
      if (box.width > 0 && box.height > 0) out.push("Open-on-phone promo visible on phone viewport");
    }
    // Trail / panel cards crushing titles into very narrow columns
    for (const strong of Array.from(document.querySelectorAll(".kn-dep-copy strong, .knowledge-panel h2"))) {
      const el = strong as HTMLElement;
      const box = el.getBoundingClientRect();
      if (box.width > 0 && box.width < 80 && (el.textContent?.length ?? 0) > 20) {
        out.push(`crushed text width ${Math.round(box.width)}: “${(el.textContent || "").slice(0, 32)}”`);
      }
    }
    return out;
  });
  await page.screenshot({ path: path.join(afterDir, `${label}.png`), fullPage: true });
  return issues.map((i) => `${label}: ${i}`);
}

test("mobile audit: home library facts knowledge review editor", async ({ page }) => {
  const all: string[] = [];

  await page.goto(instance.baseURL);
  await expect(page.locator("body")).toBeVisible();
  all.push(...(await audit(page, "01-home")));

  await page.goto(`${instance.baseURL}/library`);
  await expect(page.locator(".library-page, .library-shell, [aria-label='Citation library']").first()).toBeVisible({
    timeout: 20_000,
  });
  all.push(...(await audit(page, "02-library")));

  await page.goto(`${instance.baseURL}/facts`);
  await expect(page.locator(".facts-shell, .library-facts-view, h1, [aria-label*='Fact']").first()).toBeVisible({
    timeout: 20_000,
  });
  all.push(...(await audit(page, "03-facts")));

  await page.goto(`${instance.baseURL}/knowledge`);
  await expect(page.locator(".knowledge-shell, .knowledge-main").first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".knowledge-loading")).toHaveCount(0, { timeout: 30_000 }).catch(() => undefined);
  all.push(...(await audit(page, "04-knowledge")));

  // Focus a knowledge node so the trail panel appears.
  const graph = (await (
    await fetch(`${instance.baseURL}/api/knowledge/graph`, { headers: { Origin: instance.baseURL } })
  ).json()) as { nodes: Array<{ id: string; kind: string }> };
  const kn = graph.nodes.find((n) => n.kind === "knowledge");
  if (kn) {
    await page.goto(`${instance.baseURL}/knowledge?focus=${encodeURIComponent(kn.id)}`);
    await expect(page.locator(".knowledge-panel").first()).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".knowledge-panel.is-collapsed")).toHaveCount(0, { timeout: 10_000 });
    all.push(...(await audit(page, "05-knowledge-focus")));
  }

  await page.goto(`${instance.baseURL}/review`);
  await expect(page.getByRole("heading", { name: "Review", exact: true })).toBeVisible({ timeout: 20_000 });
  all.push(...(await audit(page, "06-review")));

  const projects = (await (
    await fetch(`${instance.baseURL}/api/projects`, { headers: { Origin: instance.baseURL } })
  ).json()) as { projects?: Array<{ id: string; name?: string; title?: string; knowledgeId?: string }> };
  const list = projects.projects ?? (projects as unknown as Array<{ id: string; knowledgeId?: string }>);
  const market = (Array.isArray(list) ? list : []).find(
    (p) => (p as { knowledgeId?: string }).knowledgeId === "demo-us-market-size" || /market/i.test(JSON.stringify(p)),
  );
  if (market?.id) {
    await page.goto(`${instance.baseURL}/p/${encodeURIComponent(market.id)}?review=1`);
    await expect(page.locator(".workspace, .editor-page, .pane-tree").first()).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.workspace[data-mobile-pane="files"]')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("tab", { name: "Trail" })).toHaveAttribute("aria-selected", "true");
    all.push(...(await audit(page, "07-editor-trail")));
    await page.getByRole("button", { name: "Source", exact: true }).click();
    all.push(...(await audit(page, "08-editor-source")));
    await page.getByRole("button", { name: "Preview", exact: true }).click();
    all.push(...(await audit(page, "09-editor-preview")));
  }

  // Soft report — fail only on hard overflow / crushed trail.
  const hard = all.filter((i) => /overflow|crushed/.test(i));
  expect(hard, hard.join("\n")).toEqual([]);
});
