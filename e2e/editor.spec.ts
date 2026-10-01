import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { startInstance, type Instance } from "./instance";

let instance: Instance;

test.beforeAll(async () => {
  instance = await startInstance();
});

test.afterAll(async () => {
  await instance.stop();
});

test.beforeEach(async ({ page }) => {
  const external: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    if (/cdn\.jsdelivr\.net|fonts\.googleapis\.com|fonts\.gstatic\.com/.test(url)) external.push(url);
  });
  await page.route(/cdn\.jsdelivr\.net|fonts\.googleapis\.com/, (route) => route.abort());
  (page as unknown as { external?: string[] }).external = external;
});

async function createProject(id: string): Promise<void> {
  const res = await fetch(`${instance.baseURL}/api/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: instance.baseURL },
    body: JSON.stringify({ id }),
  });
  if (!res.ok) throw new Error(await res.text());
}

test("editor stays offline and undo does not wipe the file", async ({ page }) => {
  await createProject("undo-paper");
  const file = path.join(instance.projects, "undo-paper", "main.tex");
  const original = fs.readFileSync(file, "utf8");
  expect(original.length).toBeGreaterThan(0);
  await page.goto(`${instance.baseURL}/p/undo-paper`);
  await expect(page.locator(".monaco-editor").first()).toBeVisible();
  await page.waitForTimeout(500);
  const external = (page as unknown as { external?: string[] }).external ?? [];
  expect(external).toEqual([]);
  await page.locator(".monaco-editor").first().click();
  for (let i = 0; i < 8; i += 1) await page.keyboard.press("Control+Z");
  await page.keyboard.press("Control+s");
  await page.waitForTimeout(800);
  const after = fs.readFileSync(file, "utf8");
  expect(after).toBe(original);
  expect(after.length).toBeGreaterThan(0);
});

test("two editors keep both edits and show presence", async ({ browser }) => {
  await createProject("collab-paper");
  const root = path.join(instance.projects, "collab-paper");
  const cfg = JSON.parse(fs.readFileSync(path.join(root, "openleaf.json"), "utf8")) as {
    identities?: Array<{ id: string; name: string; color: string }>;
  };
  cfg.identities = [
    { id: "ada", name: "Ada", color: "#0F766E" },
    { id: "grace", name: "Grace", color: "#7C3AED" },
  ];
  fs.writeFileSync(path.join(root, "openleaf.json"), `${JSON.stringify(cfg, null, 2)}\n`);
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const other = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const left = await desktop.newPage();
  const right = await other.newPage();
  await left.goto(`${instance.baseURL}/p/collab-paper`);
  await right.goto(`${instance.baseURL}/p/collab-paper`);
  await expect(left.locator(".monaco-editor").first()).toBeVisible();
  await expect(right.locator(".monaco-editor").first()).toBeVisible();
  await expect
    .poll(async () => {
      const a = await left.locator(".presence-strip").getAttribute("title");
      const b = await right.locator(".presence-strip").getAttribute("title");
      return `${a} || ${b}`;
    })
    .toMatch(/2 editors/);
  await left.locator(".monaco-editor .view-lines").first().click();
  await left.keyboard.insertText("ADAEDIT");
  await expect.poll(() => fs.readFileSync(path.join(root, "main.tex"), "utf8"), { timeout: 15_000 }).toMatch(/ADAEDIT/);
  await left.waitForTimeout(1500);
  expect(fs.readFileSync(path.join(root, "main.tex"), "utf8")).toMatch(/ADAEDIT/);
  await desktop.close();
  await other.close();
});

test("a broken compile shows an error badge", async ({ page }) => {
  await createProject("bad-paper");
  const file = path.join(instance.projects, "bad-paper", "main.tex");
  fs.writeFileSync(file, "\\documentclass{article}\n\\begin{document}\n\\thisisnotamacro\n\\end{document}\n");
  await page.goto(`${instance.baseURL}/p/bad-paper`);
  await expect(page.locator(".monaco-editor").first()).toBeVisible();
  await page.getByRole("button", { name: "Recompile", exact: true }).click();
  const badge = page.getByRole("button", { name: "1 error" });
  await expect(badge).toBeVisible();
  await badge.click();
  await expect(page.locator(".compile-issue.is-error").first()).toBeVisible();
});
