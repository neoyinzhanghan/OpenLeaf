import { expect, test } from "@playwright/test";
import { startInstance, type Instance } from "./instance";

let instance: Instance;

test.beforeAll(async () => {
  instance = await startInstance();
});

test.afterAll(async () => {
  await instance.stop();
});

test("phone pairing link is single use and a tunnel link is shown", async ({ page, browser }) => {
  await page.goto(instance.baseURL);
  await page.getByRole("button", { name: "Open on your phone" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("radio", { name: /Same Wi-Fi/ }).check();
  const address = page.locator(".host-access-field select");
  const hasAddress = await address
    .waitFor({ state: "visible", timeout: 5000 })
    .then(async () => (await address.locator("option").count()) > 0)
    .catch(() => false);
  if (hasAddress) {
    await page.getByRole("button", { name: "Create link" }).click();
    const code = page.locator(".host-access-link code");
    await expect(code).toBeVisible();
    const url = (await code.innerText()).trim();
    expect(url).toMatch(/^http:\/\/(?!127\.0\.0\.1|localhost)/);
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
    const mobile = await phone.newPage();
    await mobile.goto(url);
    await expect(mobile.locator("body")).toContainText(/Projects|Sign in|OpenLeaf/);
    await mobile.goto(url);
    await expect(mobile.locator("body")).toContainText(/expired or was already used|Sign in/);
    await phone.close();
    await page.getByRole("button", { name: "New link" }).click();
  }
  await page.getByRole("radio", { name: /From anywhere/ }).check();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Create link" }).click();
  await expect(page.locator(".host-access-link code")).toContainText("fake-words-here.trycloudflare.com", {
    timeout: 20_000,
  });
});
