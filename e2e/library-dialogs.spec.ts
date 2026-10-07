import { expect, test } from "@playwright/test";
import { startInstance, type Instance } from "./instance";

let instance: Instance;

test.beforeAll(async () => {
  instance = await startInstance();
});

test.afterAll(async () => {
  await instance.stop();
});

async function createProject(id: string): Promise<void> {
  const res = await fetch(`${instance.baseURL}/api/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: instance.baseURL },
    body: JSON.stringify({ id }),
  });
  if (!res.ok) throw new Error(await res.text());
}

test("library share, AI link, and review dialogs overlay the panel", async ({ page }) => {
  await createProject("library-dialogs");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${instance.baseURL}/p/library-dialogs`);
  await expect(page.locator(".monaco-editor").first()).toBeVisible();
  await page.getByRole("button", { name: "Cite", exact: true }).click();

  const library = page.getByRole("dialog", { name: "Citation library" });
  await expect(library).toBeVisible();

  const dialogs: Array<{ button: string; name: string }> = [
    { button: "Share", name: "Share papers" },
    { button: "AI link", name: "Library AI link" },
    { button: "Review", name: "Review AI library additions" },
  ];

  for (const { button, name } of dialogs) {
    await library.getByRole("button", { name: button, exact: true }).click();
    const dialog = page.getByRole("dialog", { name });
    await expect(dialog).toBeVisible();
    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    const style = await dialog.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { position: cs.position, zIndex: cs.zIndex };
    });
    expect(style.position).toBe("fixed");
    expect(Number(style.zIndex)).toBeGreaterThan(42);
    const covers = await dialog.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + 48);
      return hit === el || el.contains(hit);
    });
    expect(covers).toBe(true);

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(library).toBeVisible();

    await library.getByRole("button", { name: "Close", exact: true }).click();
    await expect(library).toHaveCount(0);
    await page.getByRole("button", { name: "Cite", exact: true }).click();
    await expect(library).toBeVisible();
    await expect(page.getByRole("dialog", { name })).toHaveCount(0);
  }
});
