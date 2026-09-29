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

function deviceLabel(userAgent: string): string {
  const ua = userAgent || "this device";
  return ua.length > 80 ? `${ua.slice(0, 80)}…` : ua;
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
    res.type("html").send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Sign in to OpenLeaf</title>
</head>
<body>
<main>
<h1>Sign in to OpenLeaf on this device?</h1>
<p>This link has expired or was already used.</p>
<form method="get" action="/">
<input type="hidden" name="pair" value="invalid">
<button type="submit">Sign in</button>
</form>
</main>
</body>
</html>`);
    return;
  }
  const nonce = crypto.randomBytes(24).toString("base64url");
  pairNonces.set(token, { nonce, expiresAt: Date.now() + 10 * 60_000 });
  const label = escapeHtml(deviceLabel(req.get("user-agent") ?? ""));
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex");
  res.type("html").send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Sign in to OpenLeaf</title>
</head>
<body>
<main>
<h1>Sign in to OpenLeaf on this device?</h1>
<p>${label}</p>
<form method="post">
<input type="hidden" name="nonce" value="${nonce}">
<button type="submit">Sign in</button>
</form>
</main>
</body>
</html>`);
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
