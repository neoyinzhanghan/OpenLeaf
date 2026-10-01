import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { chromium, expect, test, type BrowserContext, type Page } from "@playwright/test";
import { startInstance, type Instance } from "./instance";

let instance: Instance;

test.beforeAll(async () => {
  instance = await startInstance();
});

test.afterAll(async () => {
  await instance.stop();
});

test.describe.configure({ mode: "serial" });

type Raw = { status: number; headers: http.IncomingHttpHeaders; body: string };

function request(
  method: string,
  urlPath: string,
  opts?: { host?: string; cookie?: string; json?: unknown },
): Promise<Raw> {
  const base = new URL(instance.baseURL);
  const host = opts?.host ?? base.host;
  const payload = opts?.json === undefined ? null : JSON.stringify(opts.json);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: base.hostname,
        port: base.port,
        path: urlPath,
        method,
        headers: {
          Host: host,
          Origin: `http://${host}`,
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
          ...(opts?.cookie ? { Cookie: opts.cookie } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk as Buffer));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function cookieJar(headers: http.IncomingHttpHeaders, prev = ""): string {
  const raw = headers["set-cookie"] ?? [];
  const list = Array.isArray(raw) ? raw : [raw];
  const next = new Map<string, string>();
  for (const part of prev.split(";").map((item) => item.trim()).filter(Boolean)) {
    const i = part.indexOf("=");
    if (i > 0) next.set(part.slice(0, i), part.slice(i + 1));
  }
  for (const line of list) {
    const pair = line.split(";")[0] ?? "";
    const i = pair.indexOf("=");
    if (i > 0) next.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
  return [...next.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

/** Serve the share hostname on a local HTTP port so the guest UI can load. */
function hostProxy(tunnelHost: string): Promise<{ url: string; close: () => Promise<void> }> {
  const base = new URL(instance.baseURL);
  const proxy = http.createServer((req, res) => {
    const headers = { ...req.headers, host: tunnelHost, origin: `https://${tunnelHost}` };
    const upstream = http.request(
      {
        hostname: base.hostname,
        port: base.port,
        path: req.url,
        method: req.method,
        headers,
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });
  proxy.on("upgrade", (req, socket, head) => {
    const headers = { ...req.headers, host: tunnelHost, origin: `https://${tunnelHost}` };
    const upstream = http.request({
      hostname: base.hostname,
      port: base.port,
      path: req.url,
      method: req.method,
      headers,
    });
    upstream.on("upgrade", (up, usocket, uhead) => {
      const lines = [`HTTP/1.1 ${up.statusCode ?? 101} ${up.statusMessage ?? "Switching Protocols"}`];
      for (const [key, value] of Object.entries(up.headers)) {
        if (value == null) continue;
        const list = Array.isArray(value) ? value : [value];
        for (const item of list) lines.push(`${key}: ${item}`);
      }
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (uhead.length) socket.write(uhead);
      if (head.length) usocket.write(head);
      usocket.pipe(socket);
      socket.pipe(usocket);
    });
    upstream.on("error", () => socket.destroy());
    upstream.end();
  });
  return new Promise((resolve, reject) => {
    proxy.listen(0, "127.0.0.1", () => {
      const address = proxy.address();
      if (!address || typeof address === "string") {
        reject(new Error("proxy port"));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise((done) => {
            proxy.close(() => done());
          }),
      });
    });
  });
}

async function guestSession(projectId: string): Promise<{ hostname: string; cookie: string; guestId: string }> {
  const started = await request("POST", `/api/projects/${projectId}/share`, {
    json: {
      branchId: "main",
      allowMainShare: true,
      ttlMinutes: 30,
      readOnly: false,
      allowCompile: true,
      allowDownload: false,
      allowHistory: false,
    },
  });
  expect(started.status, started.body).toBe(201);
  let session = JSON.parse(started.body).session as {
    status: string;
    hostname: string;
    username: string;
    password: string;
    inviteUrl: string;
  };
  const deadline = Date.now() + 20_000;
  while (session.status !== "active" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const polled = await request("GET", `/api/projects/${projectId}/share?branchId=main`);
    session = JSON.parse(polled.body).session ?? session;
  }
  expect(session.status).toBe("active");
  const invite = new URL(session.inviteUrl);
  const joined = await request("GET", `${invite.pathname}${invite.search}`, { host: session.hostname });
  expect(joined.status).toBe(302);
  const cookies = cookieJar(joined.headers);
  const login = await request("POST", "/api/guest/login", {
    host: session.hostname,
    cookie: cookies,
    json: { username: session.username, password: session.password, displayName: "Guest Ada" },
  });
  expect(login.status, login.body).toBe(200);
  const guestId = (JSON.parse(login.body).guest as { id: string }).id;
  return { hostname: session.hostname, cookie: cookieJar(login.headers, cookies), guestId };
}

async function openAsGuest(context: BrowserContext, proxyUrl: string, projectId: string, cookie: string): Promise<Page> {
  const pairs = cookie.split(";").map((part) => part.trim()).filter(Boolean);
  await context.addCookies(
    pairs.map((part) => {
      const i = part.indexOf("=");
      return { name: part.slice(0, i), value: decodeURIComponent(part.slice(i + 1)), url: proxyUrl };
    }),
  );
  const page = await context.newPage();
  await page.goto(`${proxyUrl}/p/${encodeURIComponent(projectId)}`);
  return page;
}

test("a guest sees a host lock, stays read-only, and can still comment", async () => {
  const id = "access-guest";
  const created = await request("POST", "/api/projects", { json: { id } });
  expect(created.status, created.body).toBe(201);
  const bib = "ORIGINAL line\n";
  const written = await request("PUT", `/api/projects/${id}/files/references.bib`, { json: { content: bib } });
  expect(written.status, written.body).toBe(200);
  const locked = await request("PUT", `/api/projects/${id}/file-access/rules`, {
    json: { upsert: [{ path: "references.bib", level: "host" }] },
  });
  expect(locked.status, locked.body).toBe(200);

  const guest = await guestSession(id);
  const proxy = await hostProxy(guest.hostname);
  const browser = await chromium.launch({
    args: [`--unsafely-treat-insecure-origin-as-secure=${proxy.url}`],
  });
  const context = await browser.newContext();
  const page = await openAsGuest(context, proxy.url, id, guest.cookie);
  const row = page.getByRole("button", { name: /references\.bib/ });
  await expect(row).toBeVisible();
  await expect(row).toContainText("host");
  await row.click();
  await expect(page.locator(".file-access-banner")).toHaveText("Read-only: the host locked this file. You can still comment.");
  await expect(page.getByRole("button", { name: "Comment" })).toBeVisible();
  await page.locator(".monaco-editor").first().click();
  await page.keyboard.type("GUEST EDIT");
  await page.waitForTimeout(400);
  expect(fs.readFileSync(path.join(instance.projects, id, "references.bib"), "utf8")).toBe(bib);

  const comment = await request("POST", `/api/projects/${id}/comments`, {
    host: guest.hostname,
    cookie: guest.cookie,
    json: { identityId: guest.guestId, body: "Still readable", anchor: { file: "references.bib", line: 1 } },
  });
  expect(comment.status, comment.body).toBe(201);
  expect(fs.readFileSync(path.join(instance.projects, id, "references.bib"), "utf8")).toBe(bib);
  await context.close();
  await browser.close();
  await proxy.close();
});

test("a paired phone cannot unlock a protected file", async ({ page, browser }) => {
  const id = "access-phone";
  const created = await request("POST", "/api/projects", { json: { id } });
  expect(created.status, created.body).toBe(201);
  await page.goto(instance.baseURL);
  await page.getByRole("button", { name: "Open on your phone" }).click();
  await expect
    .poll(async () => {
      await page.getByRole("radio", { name: /Same Wi-Fi/ }).check();
      return page.locator(".host-access-field select option").count();
    })
    .toBeGreaterThan(0);
  await page.locator(".host-access-field select").selectOption("127.0.0.2");
  await page.getByRole("button", { name: "Create link" }).click();
  const url = (await page.locator(".host-access-link code").innerText()).trim();
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const mobile = await phone.newPage();
  await mobile.goto(url);
  await mobile.getByRole("button", { name: "Sign in" }).click();
  const card = mobile.getByRole("link", { name: `Open ${id}` });
  const box = await card.boundingBox();
  if (!box) throw new Error("project card missing");
  await card.click({ position: { x: 24, y: box.height - 12 } });
  await mobile.getByRole("button", { name: "Files", exact: true }).click();
  const settings = mobile.getByRole("button", { name: /openleaf\.json/ });
  await expect(settings).toBeVisible();
  await expect(settings.locator(".tree-access")).toHaveAttribute("title", /Protected/);
  await settings.click({ button: "right" });
  const who = mobile.getByRole("button", { name: "Who can edit" });
  await expect(who).toBeDisabled();
  await expect(who).toHaveAttribute("title", /Protected/);
  await phone.close();
});
