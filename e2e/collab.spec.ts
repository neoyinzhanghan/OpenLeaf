import fs from "node:fs";
import path from "node:path";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { startInstance, type Instance } from "./instance";

let instance: Instance;

test.beforeAll(async () => {
  instance = await startInstance();
});

test.afterAll(async () => {
  await instance.stop();
});

test.describe.configure({ mode: "serial", timeout: 90_000 });

async function createProject(id: string): Promise<string> {
  const res = await fetch(`${instance.baseURL}/api/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: instance.baseURL },
    body: JSON.stringify({ id }),
  });
  if (!res.ok) throw new Error(await res.text());
  const root = path.join(instance.projects, id);
  const cfgPath = path.join(root, "openleaf.json");
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")) as { identities?: unknown[] };
  cfg.identities = [
    { id: "ada", name: "Ada", color: "#0F766E" },
    { id: "grace", name: "Grace", color: "#7C3AED" },
  ];
  fs.writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`);
  return root;
}

async function openPair(browser: Browser, id: string): Promise<{
  adaCtx: BrowserContext;
  graceCtx: BrowserContext;
  ada: Page;
  grace: Page;
}> {
  const adaCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const graceCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const ada = await adaCtx.newPage();
  const grace = await graceCtx.newPage();
  await ada.addInitScript((projectId) => {
    (window as Window & { __openleafWantCollabDebug?: boolean }).__openleafWantCollabDebug = true;
    localStorage.setItem(`openleaf.identityId.${projectId}`, "ada");
  }, id);
  await grace.addInitScript((projectId) => {
    (window as Window & { __openleafWantCollabDebug?: boolean }).__openleafWantCollabDebug = true;
    localStorage.setItem(`openleaf.identityId.${projectId}`, "grace");
  }, id);
  await ada.goto(`${instance.baseURL}/p/${id}`);
  await grace.goto(`${instance.baseURL}/p/${id}`);
  await expect(ada.locator(".monaco-editor").first()).toBeVisible();
  await expect(grace.locator(".monaco-editor").first()).toBeVisible();
  await expect
    .poll(async () => ada.locator(".presence-strip").getAttribute("title"))
    .toMatch(/2 editors/);
  const settled = async (page: Page) => {
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const debug = (
              window as Window & { __openleafCollabDebug?: { synced: () => boolean } }
            ).__openleafCollabDebug;
            return debug?.synced() ?? false;
          }),
        { timeout: 15_000 },
      )
      .toBe(true);
  };
  await settled(ada);
  await settled(grace);
  return { adaCtx, graceCtx, ada, grace };
}

async function editorHas(page: Page, needle: string): Promise<void> {
  await expect
    .poll(async () =>
      page.evaluate((expected) => {
        const debug = (window as Window & {
          __openleafCollabDebug?: { text: (filePath: string) => string | null };
        }).__openleafCollabDebug;
        return debug?.text("main.tex")?.includes(expected) ?? false;
      }, needle),
    )
    .toBe(true);
}

test("sequential edits survive in both orders", async ({ browser }) => {
  const id = "collab-orders";
  const root = await createProject(id);
  const file = path.join(root, "main.tex");
  const { adaCtx, graceCtx, ada, grace } = await openPair(browser, id);
  const typeMarker = async (page: Page, marker: string) => {
    await expect
      .poll(async () => {
        await page.locator(".monaco-editor .view-lines").first().click();
        await page.keyboard.insertText(`% ${marker}\n`);
        return page.evaluate((needle) => {
          const debug = (
            window as Window & { __openleafCollabDebug?: { text: (filePath: string) => string | null } }
          ).__openleafCollabDebug;
          return debug?.text("main.tex")?.includes(needle) ?? false;
        }, marker);
      })
      .toBe(true);
  };
  await typeMarker(grace, "from-grace");
  await expect.poll(() => fs.readFileSync(file, "utf8"), { timeout: 15_000 }).toMatch(/from-grace/);
  await typeMarker(ada, "from-ada");
  await expect.poll(() => fs.readFileSync(file, "utf8"), { timeout: 15_000 }).toMatch(/from-ada/);
  await ada.waitForTimeout(5_000);
  const disk = fs.readFileSync(file, "utf8");
  expect(disk).toMatch(/from-grace/);
  expect(disk).toMatch(/from-ada/);
  await editorHas(ada, "from-grace");
  await editorHas(ada, "from-ada");
  await editorHas(grace, "from-grace");
  await editorHas(grace, "from-ada");
  await adaCtx.close();
  await graceCtx.close();
});

test("concurrent typing on different lines keeps both edits", async ({ browser }) => {
  const id = "collab-concurrent";
  const root = await createProject(id);
  const file = path.join(root, "main.tex");
  const { adaCtx, graceCtx, ada, grace } = await openPair(browser, id);
  await ada.locator(".monaco-editor").first().click();
  await grace.locator(".monaco-editor").first().click();
  await ada.keyboard.press("Control+Home");
  await grace.keyboard.press("Control+End");
  await Promise.all([ada.keyboard.insertText("% ada-top\n"), grace.keyboard.insertText("\n% grace-end\n")]);
  await ada.waitForTimeout(5_000);
  const disk = fs.readFileSync(file, "utf8");
  expect(disk).toMatch(/ada-top/);
  expect(disk).toMatch(/grace-end/);
  await editorHas(ada, "grace-end");
  await editorHas(grace, "ada-top");
  await adaCtx.close();
  await graceCtx.close();
});

test("a disk edit while both editors are open reaches both", async ({ browser }) => {
  const id = "collab-disk";
  const root = await createProject(id);
  const file = path.join(root, "main.tex");
  const { adaCtx, graceCtx, ada, grace } = await openPair(browser, id);
  const current = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, current.replace("\\begin{document}", "\\begin{document}\n% from-disk\n"));
  await editorHas(ada, "from-disk");
  await editorHas(grace, "from-disk");
  await ada.waitForTimeout(5_000);
  expect(fs.readFileSync(file, "utf8")).toMatch(/from-disk/);
  await adaCtx.close();
  await graceCtx.close();
});

test("recompile of an unchanged project is not an error", async ({ page }) => {
  const id = "recompile-ok";
  const res = await fetch(`${instance.baseURL}/api/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: instance.baseURL },
    body: JSON.stringify({ id }),
  });
  if (!res.ok) throw new Error(await res.text());
  const first = await fetch(`${instance.baseURL}/api/projects/${id}/compile`, {
    method: "POST",
    headers: { Origin: instance.baseURL },
  });
  expect(first.ok).toBe(true);
  await page.goto(`${instance.baseURL}/p/${id}`);
  await expect(page.locator(".monaco-editor").first()).toBeVisible();
  await page.getByRole("button", { name: "Recompile" }).click();
  await expect(page.locator(".status-pill").first()).not.toHaveText("Error", { timeout: 60_000 });
  await expect(page.locator(".status-pill.err")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("Showing the last successful PDF");
});
