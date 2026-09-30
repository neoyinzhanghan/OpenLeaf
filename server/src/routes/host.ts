import crypto from "node:crypto";
import express, { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import { z, ZodError } from "zod";
import { loadConfig } from "../config.js";
import { publicErrorMessage } from "../http/jsonErrors.js";
import {
  clearHostCookieHeader,
  hostCookieHeader,
  hostLogin,
  readPlainHostPassword,
  requestIsHttps,
  resetHostPassword,
  verifyHostCookie,
} from "../services/hostAuth.js";
import {
  cancelPairing,
  createPairing,
  getPairing,
  isPendingPairingToken,
  listDevices,
  redeemPairing,
  renameDevice,
  revokeAllDevices,
  revokeDevice,
} from "../services/hostDevices.js";
import { hostGatewayPublicView, startHostGateway, stopHostGateway } from "../services/hostGateway.js";
import { lanAccessRunning, lanAddresses, startLanAccess, stopLanAccess } from "../services/lanAccess.js";
import { isLoopbackOwner } from "../services/requestGuard.js";
import { clientIp } from "../services/shareAuth.js";

function statusOf(err: unknown): number {
  if (err instanceof ZodError) return 400;
  if (err && typeof err === "object" && "status" in err && typeof (err as { status: unknown }).status === "number") {
    return (err as { status: number }).status;
  }
  return 500;
}

function requireLoopback(req: Request, res: Response, next: NextFunction): void {
  if (!isLoopbackOwner(req)) {
    res.status(403).json({ error: "Only the computer running OpenLeaf can do this", code: "LOOPBACK_ONLY" });
    return;
  }
  next();
}

export const hostRouter = Router();

hostRouter.get("/me", (req, res) => {
  const session = verifyHostCookie(req);
  if (!session) {
    res.json({ authenticated: false });
    return;
  }
  res.json({ authenticated: true, username: session.username, deviceId: session.deviceId ?? null });
});

hostRouter.get("/gateway", (_req, res) => {
  res.json(hostGatewayPublicView());
});

hostRouter.post("/login", (req, res) => {
  const schema = z.object({
    username: z.string().min(1).max(80),
    password: z.string().min(1).max(200),
  });
  try {
    const body = schema.parse(req.body);
    const { username, token } = hostLogin(body, clientIp(req), req.get("user-agent") ?? "");
    res.setHeader("Set-Cookie", hostCookieHeader(token, requestIsHttps(req)));
    res.json({ ok: true, username });
  } catch (err) {
    res.status(statusOf(err)).json({ error: publicErrorMessage(err, "Sign-in failed") });
  }
});

hostRouter.post("/logout", (req, res) => {
  const session = verifyHostCookie(req);
  if (session?.deviceId) revokeDevice(session.deviceId);
  res.setHeader("Set-Cookie", clearHostCookieHeader(requestIsHttps(req)));
  res.json({ ok: true });
});

hostRouter.post("/pairings", requireLoopback, async (req, res) => {
  const schema = z.object({
    route: z.enum(["lan", "tunnel"]),
    lanAddress: z.string().min(1).optional(),
    next: z.string().max(500).optional(),
    riskAck: z.boolean().optional(),
  });
  try {
    const body = schema.parse(req.body ?? {});
    const cfg = loadConfig();
    if (body.route === "tunnel" && body.riskAck !== true) {
      res.status(400).json({ error: "Confirm that you understand a public link can reach this computer." });
      return;
    }
    let base = "";
    if (body.route === "lan") {
      const address = body.lanAddress;
      if (!address) {
        res.status(400).json({ error: "Choose a Wi-Fi address first." });
        return;
      }
      const port = process.env.NODE_ENV === "production" ? cfg.port : cfg.client.devPort;
      await startLanAccess(address, cfg.port);
      base = `http://${address}:${port}`;
    } else {
      const gateway = await startHostGateway({ demand: true });
      if (!gateway.url) {
        res.status(503).json({
          error: gateway.error || "The tunnel did not start. Install cloudflared, then try again.",
        });
        return;
      }
      base = gateway.url.replace(/\/$/, "");
    }
    const next = body.next && body.next.startsWith("/") && !body.next.startsWith("//") ? body.next : "/";
    const created = createPairing({ route: body.route, lanAddress: body.lanAddress, next });
    res.json({
      id: created.id,
      url: `${base}/host/pair/${created.token}`,
      expiresAt: created.expiresAt,
    });
  } catch (err) {
    res.status(statusOf(err)).json({ error: publicErrorMessage(err, "Could not create a phone link") });
  }
});

hostRouter.get("/pairings/:id", requireLoopback, (req, res) => {
  const pairing = getPairing(req.params.id);
  if (!pairing) {
    res.status(404).json({ error: "That link is no longer available." });
    return;
  }
  res.json(pairing);
});

hostRouter.delete("/pairings/:id", requireLoopback, (req, res) => {
  cancelPairing(req.params.id);
  res.json({ ok: true });
});

hostRouter.get("/devices", (req, res) => {
  const session = verifyHostCookie(req);
  if (isLoopbackOwner(req)) {
    res.json({ devices: listDevices() });
    return;
  }
  if (!session?.deviceId) {
    res.status(401).json({ error: "Sign in required", code: "HOST_AUTH" });
    return;
  }
  const own = listDevices().filter((device) => device.id === session.deviceId);
  res.json({ devices: own });
});

hostRouter.patch("/devices/:id", (req, res) => {
  if (!isLoopbackOwner(req)) {
    res.status(403).json({ error: "Only this computer can rename devices." });
    return;
  }
  const schema = z.object({ label: z.string().min(1).max(80) });
  try {
    const body = schema.parse(req.body);
    const device = renameDevice(req.params.id, body.label);
    if (!device) {
      res.status(404).json({ error: "Device not found." });
      return;
    }
    res.json({ device });
  } catch (err) {
    res.status(statusOf(err)).json({ error: publicErrorMessage(err, "Could not rename the device") });
  }
});

hostRouter.delete("/devices/:id", (req, res) => {
  const session = verifyHostCookie(req);
  const self = session?.deviceId === req.params.id;
  if (!isLoopbackOwner(req) && !self) {
    res.status(403).json({ error: "You can only sign out this device from itself, or from the computer running OpenLeaf." });
    return;
  }
  const ok = revokeDevice(req.params.id);
  if (self) res.setHeader("Set-Cookie", clearHostCookieHeader(requestIsHttps(req)));
  res.json({ ok });
});

hostRouter.post("/devices/revoke-all", requireLoopback, (_req, res) => {
  revokeAllDevices();
  res.json({ ok: true });
});

hostRouter.get("/lan-addresses", requireLoopback, (_req, res) => {
  res.json({ ...lanAddresses(), running: lanAccessRunning() });
});

hostRouter.post("/remote", requireLoopback, async (req, res) => {
  const schema = z.object({ riskAck: z.boolean() });
  try {
    const body = schema.parse(req.body ?? {});
    if (!body.riskAck) {
      res.status(400).json({ error: "Confirm that you understand a public link can reach this computer." });
      return;
    }
    const gateway = await startHostGateway({ demand: true });
    res.json(hostGatewayPublicView());
  } catch (err) {
    res.status(statusOf(err)).json({ error: publicErrorMessage(err, "Could not start remote access") });
  }
});

hostRouter.delete("/remote", requireLoopback, (_req, res) => {
  stopHostGateway();
  res.json({ ok: true, ...hostGatewayPublicView() });
});

hostRouter.post("/lan/stop", requireLoopback, (_req, res) => {
  stopLanAccess();
  res.json({ ok: true });
});

hostRouter.post("/password/reveal", requireLoopback, (_req, res) => {
  const password = readPlainHostPassword();
  if (!password) {
    res.status(404).json({ error: "No host password is stored yet." });
    return;
  }
  res.json({ password });
});

hostRouter.post("/password/reset", requireLoopback, (req, res) => {
  const schema = z.object({ password: z.string().min(8).max(200) });
  try {
    const body = schema.parse(req.body);
    const result = resetHostPassword(body.password);
    res.json({ ok: true, username: result.username });
  } catch (err) {
    res.status(statusOf(err)).json({ error: publicErrorMessage(err, "Could not reset the password") });
  }
});

export const pairRouter = Router();
pairRouter.use(express.urlencoded({ extended: false }));

const pairNonces = new Map<string, { nonce: string; expiresAt: number }>();

export function pairNonceCount(): number {
  return pairNonces.size;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => {
    if (ch === "&") return "&amp;";
    if (ch === "<") return "&lt;";
    if (ch === ">") return "&gt;";
    if (ch === '"') return "&quot;";
    return "&#39;";
  });
}

function deviceSummary(userAgent: string): string {
  const ua = userAgent || "";
  let device = "This browser";
  if (/iPhone/i.test(ua)) device = "iPhone";
  else if (/iPad/i.test(ua)) device = "iPad";
  else if (/Android/i.test(ua)) device = /Mobile/i.test(ua) ? "Android phone" : "Android";
  else if (/Macintosh|Mac OS X/i.test(ua)) device = "Mac";
  else if (/Windows/i.test(ua)) device = "Windows";
  else if (/CrOS/i.test(ua)) device = "Chromebook";
  else if (/Linux/i.test(ua)) device = "Linux";

  let browser = "";
  if (/Edg\/|EdgiOS/i.test(ua)) browser = "Edge";
  else if (/OPR\/|Opera Mini/i.test(ua)) browser = "Opera";
  else if (/CriOS|Chrome\//i.test(ua)) browser = "Chrome";
  else if (/FxiOS|Firefox\//i.test(ua)) browser = "Firefox";
  else if (/Safari/i.test(ua)) browser = "Safari";

  return browser ? `${device} · ${browser}` : device;
}

function pairPage(opts: { expired: boolean; device?: string; nonce?: string }): string {
  const device = escapeHtml(opts.device ?? "This browser");
  const nonce = escapeHtml(opts.nonce ?? "");
  const kicker = opts.expired ? "Link expired" : "This device";
  const title = opts.expired ? "Sign in to OpenLeaf" : "Sign in to OpenLeaf?";
  const lead = opts.expired
    ? "This link has expired or was already used. On your computer, create a new phone link, or continue with the host password."
    : "Your computer asked to sign this phone in. After you confirm, you can open your projects from here.";
  const deviceRow = opts.expired
    ? ""
    : `<p class="device">${device}</p>`;
  const form = opts.expired
    ? `<form method="get" action="/">
<input type="hidden" name="pair" value="invalid">
<button type="submit">Continue</button>
</form>`
    : `<form method="post">
<input type="hidden" name="nonce" value="${nonce}">
<button type="submit">Sign in</button>
</form>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#f4f5f7" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0b0e11" media="(prefers-color-scheme: dark)">
<title>Sign in to OpenLeaf</title>
<style>
  :root {
    color-scheme: light;
    --bg: #f4f5f7;
    --card: #ffffff;
    --ink: #12171d;
    --muted: #5a6673;
    --line: #e4e7ec;
    --accent: #14665e;
    --accent-ink: #ffffff;
    --glow: rgba(26, 122, 112, 0.16);
    --chip: #f3faf8;
    --chip-ink: #14665e;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      color-scheme: dark;
      --bg: #0b0e11;
      --card: #13181e;
      --ink: #eef2f6;
      --muted: #8a96a3;
      --line: #1e262f;
      --accent: #3aafa0;
      --accent-ink: #06211e;
      --glow: rgba(94, 196, 182, 0.18);
      --chip: rgba(94, 196, 182, 0.12);
      --chip-ink: #8fd9cf;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    min-height: 100dvh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: max(1.25rem, env(safe-area-inset-top)) 1.1rem max(1.5rem, env(safe-area-inset-bottom));
    background:
      radial-gradient(720px 360px at 50% -8%, var(--glow), transparent 62%),
      var(--bg);
    color: var(--ink);
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .card {
    width: min(420px, 100%);
    display: grid;
    gap: 0.85rem;
    padding: 1.45rem 1.35rem 1.3rem;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 16px;
    box-shadow: 0 1px 2px rgba(18, 23, 29, 0.04), 0 16px 40px rgba(18, 23, 29, 0.08);
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    font-weight: 700;
    letter-spacing: -0.03em;
    font-size: 1.02rem;
  }
  .brand img { width: 28px; height: 28px; border-radius: 7px; }
  .kicker {
    margin: 0.35rem 0 0;
    font-size: 0.72rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--accent);
  }
  h1 {
    margin: 0;
    font-size: 1.65rem;
    line-height: 1.15;
    letter-spacing: -0.03em;
    font-weight: 700;
  }
  .lead {
    margin: 0;
    color: var(--muted);
    font-size: 0.95rem;
    line-height: 1.5;
  }
  .device {
    margin: 0.15rem 0 0.1rem;
    justify-self: start;
    padding: 0.35rem 0.7rem;
    border-radius: 999px;
    background: var(--chip);
    color: var(--chip-ink);
    font-size: 0.82rem;
    font-weight: 650;
    letter-spacing: -0.01em;
  }
  button {
    appearance: none;
    width: 100%;
    min-height: 48px;
    margin-top: 0.25rem;
    border: 0;
    border-radius: 10px;
    background: var(--accent);
    color: var(--accent-ink);
    font: inherit;
    font-size: 1rem;
    font-weight: 650;
    letter-spacing: -0.01em;
    cursor: pointer;
  }
  button:hover { filter: brightness(1.06); }
  button:focus-visible { outline: 3px solid var(--glow); outline-offset: 2px; }
</style>
</head>
<body>
<main class="card">
  <div class="brand"><img src="/logo.png" alt="">OpenLeaf</div>
  <p class="kicker">${kicker}</p>
  <h1>${title}</h1>
  <p class="lead">${lead}</p>
  ${deviceRow}
  ${form}
</main>
</body>
</html>`;
}

function prunePairNonces(now = Date.now()): void {
  for (const [token, row] of pairNonces) {
    if (row.expiresAt <= now || !isPendingPairingToken(token)) pairNonces.delete(token);
  }
}

pairRouter.get("/:token", (req, res) => {
  prunePairNonces();
  const token = String(req.params.token);
  if (!isPendingPairingToken(token)) {
    pairNonces.delete(token);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Robots-Tag", "noindex");
    res.type("html").send(pairPage({ expired: true }));
    return;
  }
  const nonce = crypto.randomBytes(24).toString("base64url");
  pairNonces.set(token, { nonce, expiresAt: Date.now() + 10 * 60_000 });
  const device = deviceSummary(req.get("user-agent") ?? "");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex");
  res.type("html").send(pairPage({ expired: false, device, nonce }));
});

pairRouter.post("/:token", (req, res) => {
  const origin = req.get("origin") ?? "";
  const host = (req.get("host") ?? "").toLowerCase();
  let originHost = "";
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    originHost = "";
  }
  const token = String(req.params.token);
  const row = pairNonces.get(token);
  const nonce = typeof req.body?.nonce === "string" ? req.body.nonce : "";
  if (!origin || originHost !== host || !row || row.expiresAt < Date.now() || nonce !== row.nonce) {
    res.status(403).type("text/plain").send("Forbidden");
    return;
  }
  pairNonces.delete(token);
  const redeemed = redeemPairing(token, {
    userAgent: req.get("user-agent") ?? "",
    ip: clientIp(req),
  });
  if (!redeemed) {
    res.redirect(302, "/?pair=invalid");
    return;
  }
  res.setHeader("Set-Cookie", hostCookieHeader(redeemed.sessionToken, requestIsHttps(req)));
  const next = redeemed.next && redeemed.next.startsWith("/") && !redeemed.next.startsWith("//") ? redeemed.next : "/";
  res.redirect(302, next);
});
