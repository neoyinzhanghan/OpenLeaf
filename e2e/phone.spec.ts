import { expect, test, type Page } from "@playwright/test";
import { startInstance, type Instance } from "./instance";

let instance: Instance;

test.beforeAll(async () => {
  instance = await startInstance();
});

test.afterAll(async () => {
  await instance.stop();
});

test.describe.configure({ mode: "serial" });

async function chooseLan(page: Page): Promise<void> {
  await expect
    .poll(async () => {
      await page.getByRole("radio", { name: /Same Wi-Fi/ }).check();
      return page.locator(".host-access-field select option").count();
    })
    .toBeGreaterThan(0);
  await page.locator(".host-access-field select").selectOption("127.0.0.2");
}

test("phone pairing signs in once and the device shows up on the computer", async ({ page, browser }) => {
  await page.goto(instance.baseURL);
  await page.getByRole("button", { name: "Open on your phone" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await chooseLan(page);
  await page.getByRole("button", { name: "Create link" }).click();
  const code = page.locator(".host-access-link code");
  await expect(code).toBeVisible();
  const url = (await code.innerText()).trim();
  expect(url).toMatch(/^http:\/\/127\.0\.0\.2:/);

  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const mobile = await phone.newPage();
  await mobile.goto(url);
  await mobile.getByRole("button", { name: "Sign in" }).click();
  await expect(mobile.getByRole("heading", { name: "Projects" })).toBeVisible();
  await expect(mobile.locator("body")).not.toContainText("Sign in required");

  const again = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const second = await again.newPage();
  await second.goto(url);
  await expect(second.locator("body")).toContainText("expired or was already used");
  await second.getByRole("button", { name: "Continue" }).click();
  await expect(second.locator("body")).toContainText("expired or was already used");
  await expect(second.getByRole("heading", { name: "Projects" })).toHaveCount(0);
  await phone.close();
  await again.close();

  await expect(page.getByText(/Connected:/)).toBeVisible();
  await expect(page.getByRole("textbox", { name: /Name for / })).toBeVisible();
});

test("an unpaired LAN visitor signs in with the host password", async ({ page, browser }) => {
  await page.goto(instance.baseURL);
  await page.getByRole("button", { name: "Open on your phone" }).click();
  await chooseLan(page);
  await page.getByRole("button", { name: "Create link" }).click();
  const url = (await page.locator(".host-access-link code").innerText()).trim();
  const origin = new URL(url).origin;
  const revealed = await fetch(`${instance.baseURL}/api/host/password/reveal`, {
    method: "POST",
    headers: { Origin: instance.baseURL },
  });
  expect(revealed.status).toBe(200);
  const body = (await revealed.json()) as { password: string };

  const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const mobile = await phone.newPage();
  await mobile.goto(origin);
  await expect(mobile.getByRole("heading", { name: "Sign in to OpenLeaf" })).toBeVisible();
  await expect(mobile.getByRole("heading", { name: "Projects" })).toHaveCount(0);
  await mobile.getByLabel("Username").fill("host");
  await mobile.locator("input[autocomplete='current-password']").fill(body.password);
  await mobile.getByRole("button", { name: "Sign in" }).click();
  await expect(mobile.getByRole("heading", { name: "Projects" })).toBeVisible();
  await phone.close();
});

test("revoking devices returns the phone to the login page", async ({ page, browser }) => {
  await page.goto(instance.baseURL);
  await page.getByRole("button", { name: "Open on your phone" }).click();
  await chooseLan(page);
  await page.getByRole("button", { name: "Create link" }).click();
  const url = (await page.locator(".host-access-link code").innerText()).trim();
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const mobile = await phone.newPage();
  await mobile.goto(url);
  await mobile.getByRole("button", { name: "Sign in" }).click();
  await expect(mobile.getByRole("heading", { name: "Projects" })).toBeVisible();
  const revoked = await fetch(`${instance.baseURL}/api/host/devices/revoke-all`, {
    method: "POST",
    headers: { Origin: instance.baseURL },
  });
  expect(revoked.status).toBe(200);
  await mobile.reload();
  await expect(mobile.getByRole("heading", { name: "Sign in to OpenLeaf" })).toBeVisible();
  await phone.close();
});

test("from anywhere uses the fake tunnel hostname", async ({ page }) => {
  await page.goto(instance.baseURL);
  await page.getByRole("button", { name: "Open on your phone" }).click();
  await page.getByRole("radio", { name: /From anywhere/ }).check();
  await page.getByRole("checkbox", { name: /public link/ }).check();
  await page.getByRole("button", { name: "Create link" }).click();
  await expect(page.locator(".host-access-link code")).toContainText("fake-words-here.trycloudflare.com", {
    timeout: 20_000,
  });
});
