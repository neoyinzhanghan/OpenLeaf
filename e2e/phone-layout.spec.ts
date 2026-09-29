import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { startInstance, type Instance } from "./instance";

const shots = path.join(process.cwd(), "e2e/__screenshots__/phone");
fs.mkdirSync(shots, { recursive: true });

const viewports = [
  { name: "360x740", width: 360, height: 740 },
  { name: "390x844", width: 390, height: 844 },
  { name: "430x932", width: 430, height: 932 },
  { name: "844x390", width: 844, height: 390 },
] as const;

const themes = ["classic-light", "classic-dark"] as const;

let instance: Instance;

test.beforeAll(async () => {
  instance = await startInstance();
  for (let i = 0; i < 5; i += 1) {
    const res = await fetch(`${instance.baseURL}/api/library`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: instance.baseURL },
      body: JSON.stringify({
        title: `Phone paper ${i + 1}: a title long enough to wrap onto two lines`,
        authors: [
          { given: "Ada", family: "Lovelace" },
          { given: "Alan", family: "Turing" },
        ],
        year: 2016 + i,
        venue: "Journal of Tests",
        source: "manual",
      }),
    });
    if (!res.ok) throw new Error(await res.text());
  }
  const project = await fetch(`${instance.baseURL}/api/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: instance.baseURL },
    body: JSON.stringify({ id: "phone-layout" }),
  });
  if (!project.ok) throw new Error(await project.text());
});

test.afterAll(async () => {
  await instance.stop();
});

async function prepare(page: Page, theme: string): Promise<void> {
  await page.addInitScript((id) => {
    localStorage.setItem("openleaf.theme", id);
  }, theme);
}

async function assertPhoneChrome(page: Page, opts?: { firstPaper?: boolean }): Promise<string[]> {
  const problems = await page.evaluate((checkPaper) => {
    const issues: string[] = [];
    const root = document.documentElement;
    if (root.scrollWidth > root.clientWidth + 1) {
      issues.push(`horizontal overflow ${root.scrollWidth} > ${root.clientWidth}`);
    }
    const shown = (node: HTMLElement) => {
      if (node.closest(".monaco-editor")) return false;
      let current: HTMLElement | null = node;
      while (current) {
        const style = getComputedStyle(current);
        if (style.display === "none" || style.visibility === "hidden") return false;
        current = current.parentElement;
      }
      const box = node.getBoundingClientRect();
      return box.width >= 1 && box.height >= 1;
    };
    const controls = Array.from(
      document.querySelectorAll("button, a, input, select, textarea, [role='menuitem']"),
    );
    for (const el of controls) {
      const node = el as HTMLElement;
      const style = getComputedStyle(node);
      if (!shown(node)) continue;
      const box = node.getBoundingClientRect();
      if (box.width < 1 || box.height < 1) continue;
      if (box.height < 44) issues.push(`${node.tagName}.${node.className} height ${Math.round(box.height)}`);
      if (node.matches("input, textarea, select")) {
        const size = parseFloat(style.fontSize);
        if (size < 16) issues.push(`input font ${size}px`);
      }
    }
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let text = walker.nextNode();
    while (text) {
      const value = text.textContent?.trim() ?? "";
      const parent = text.parentElement;
      if (value && parent && shown(parent)) {
        const style = getComputedStyle(parent);
        if (style.display !== "none" && style.visibility !== "hidden") {
          const size = parseFloat(style.fontSize);
          if (size < 12) issues.push(`text ${size}px “${value.slice(0, 40)}”`);
        }
      }
      text = walker.nextNode();
    }
    if (checkPaper) {
      const title = document.querySelector(".library-item-title");
      if (!title) issues.push("no paper title");
      else {
        const top = title.getBoundingClientRect().top;
        if (top >= 160) issues.push(`first paper at ${Math.round(top)}px`);
      }
    }
    return issues.slice(0, 12);
  }, opts?.firstPaper ?? false);
  return problems;
}

for (const theme of themes) {
  for (const viewport of viewports) {
    test(`library ${viewport.name} ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await prepare(page, theme);
      await page.goto(`${instance.baseURL}/library`);
      await expect(page.locator(".library-item-title").first()).toBeVisible();
      const listProblems = await assertPhoneChrome(page, { firstPaper: viewport.name === "390x844" });
      expect(listProblems, listProblems.join("\n")).toEqual([]);
      await page.screenshot({ path: path.join(shots, `library-${viewport.name}-${theme}.png`), fullPage: true });

      const phone = viewport.width < 640;
      await page.locator(".library-item-title").first().click();
      await expect(page.locator(phone ? ".library-phone-detailbar" : ".library-detail h3")).toBeVisible();
      const detailProblems = await assertPhoneChrome(page);
      expect(detailProblems, detailProblems.join("\n")).toEqual([]);
      await page.screenshot({ path: path.join(shots, `detail-${viewport.name}-${theme}.png`), fullPage: true });
      if (phone) {
        await page.getByRole("button", { name: "Paper menu" }).click();
        await expect(page.getByRole("menuitem", { name: "Delete" })).toBeVisible();
        await page.screenshot({ path: path.join(shots, `detail-menu-${viewport.name}-${theme}.png`) });
        await page.getByRole("button", { name: "Back" }).click();
        await page.getByRole("button", { name: "+ Add" }).click();
      } else {
        await page.getByRole("button", { name: "Add paper" }).click();
      }
      await expect(page.locator(".library-import")).toBeVisible();
      const addProblems = await assertPhoneChrome(page);
      expect(addProblems, addProblems.join("\n")).toEqual([]);
      await page.screenshot({ path: path.join(shots, `add-${viewport.name}-${theme}.png`) });
      await page.getByRole("button", { name: phone ? "+ Add" : "Add paper" }).click();

      if (phone) {
        await page.getByRole("button", { name: "Library menu" }).click();
        await page.getByRole("menuitem", { name: "Share" }).click();
      } else {
        await page.getByRole("button", { name: "Share", exact: true }).click();
      }
      await expect(page.getByRole("dialog", { name: "Share papers" })).toBeVisible();
      const shareProblems = await assertPhoneChrome(page);
      expect(shareProblems, shareProblems.join("\n")).toEqual([]);
      await page.screenshot({ path: path.join(shots, `share-${viewport.name}-${theme}.png`) });
      await page.getByRole("dialog", { name: "Share papers" }).getByRole("button", { name: "Close" }).click();

      if (phone) {
        await page.getByRole("button", { name: "Library menu" }).click();
        await page.getByRole("menuitem", { name: "AI link" }).click();
      } else {
        await page.getByRole("button", { name: "AI link", exact: true }).click();
      }
      await expect(page.getByRole("dialog", { name: "Library AI link" })).toBeVisible();
      const aiProblems = await assertPhoneChrome(page);
      expect(aiProblems, aiProblems.join("\n")).toEqual([]);
      await page.getByRole("dialog", { name: "Library AI link" }).getByRole("button", { name: "Close" }).click();

      if (phone) {
        await page.getByRole("button", { name: "Library menu" }).click();
        await page.getByRole("menuitem", { name: /Review queue/ }).click();
      } else {
        await page.getByRole("button", { name: "Review", exact: true }).click();
      }
      await expect(page.getByRole("dialog", { name: "Review AI library additions" })).toBeVisible();
      const reviewProblems = await assertPhoneChrome(page);
      expect(reviewProblems, reviewProblems.join("\n")).toEqual([]);
      await page.getByRole("dialog", { name: "Review AI library additions" }).getByRole("button", { name: "Close" }).click();

      if (phone) {
        await page.getByRole("button", { name: "Library menu" }).click();
        await page.getByRole("menuitem", { name: "Lit review" }).click();
      } else {
        await page.getByRole("button", { name: "Lit review", exact: true }).click();
      }
      await expect(page.locator(".library-litreview")).toBeVisible();
      const litProblems = await assertPhoneChrome(page);
      expect(litProblems, litProblems.join("\n")).toEqual([]);
      await page.screenshot({ path: path.join(shots, `lit-${viewport.name}-${theme}.png`) });
    });
  }
}

test("editor menu is grouped on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await prepare(page, "classic-dark");
  await page.goto(`${instance.baseURL}/p/phone-layout`);
  await expect(page.locator(".monaco-editor").first()).toBeVisible();
  await page.getByRole("button", { name: "More actions" }).click();
  await expect(page.locator(".toolbar-menu-label", { hasText: "Paper" })).toBeVisible();
  await expect(page.locator(".toolbar-menu-label", { hasText: "Library" })).toBeVisible();
  await expect(page.locator(".toolbar-menu-label", { hasText: "Sharing" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Settings" })).toBeVisible();
  const problems = await assertPhoneChrome(page);
  expect(problems, problems.join("\n")).toEqual([]);
  await page.screenshot({ path: path.join(shots, "editor-menu-390x844-classic-dark.png") });
});
