import assert from "node:assert/strict";
import type { Request } from "express";
import { describe, it } from "node:test";
import { isGuestForbiddenWritePath, isHostMetadataPath } from "./projectFs.js";
import { guestRouteDenial, parseCookies } from "./shareAuth.js";
import type { ShareSession } from "./share.js";

function session(over: {
  projectId?: string;
  readOnly?: boolean;
  allowHistory?: boolean;
  allowCompile?: boolean;
  allowDownload?: boolean;
} = {}): ShareSession {
  return {
    id: "s1",
    projectId: over.projectId ?? "demo",
    branchId: "main",
    branchName: "main",
    hostname: "demo.trycloudflare.com",
    url: "https://demo.trycloudflare.com",
    username: "griffin-1",
    password: "x",
    linkToken: "tok",
    secret: Buffer.alloc(32),
    createdAt: Date.now(),
    settings: {
      expiresAt: null,
      maxIps: 8,
      maxGuests: 8,
      readOnly: over.readOnly ?? false,
      allowCompile: over.allowCompile ?? true,
      allowDownload: over.allowDownload ?? true,
      allowHistory: over.allowHistory ?? true,
    },
    ips: new Map(),
    rejectedIps: new Set(),
    guests: new Map(),
    loginFailures: new Map(),
    proc: null,
    status: "active",
    expiryTimer: null,
    dnsProbeTimer: null,
    dnsReady: true,
    logTail: [],
    events: [],
  };
}

function req(path: string, method = "GET", body?: unknown): Request {
  return { path, method, body } as Request;
}

describe("parseCookies", () => {
  it("decodes valid percent-encoding", () => {
    assert.equal(parseCookies("a=hello%20world")["a"], "hello world");
  });

  it("does not throw on malformed percent-encoding", () => {
    const out = parseCookies("openleaf_share=%E0%A4%A; other=ok");
    assert.equal(out.openleaf_share, "%E0%A4%A");
    assert.equal(out.other, "ok");
  });
});

describe("host metadata path guards", () => {
  it("flags openleaf.json and .openleaf runtime paths", () => {
    assert.equal(isHostMetadataPath("openleaf.json"), true);
    assert.equal(isHostMetadataPath(".openleaf"), true);
    assert.equal(isHostMetadataPath(".openleaf/timeline.json"), true);
    assert.equal(isHostMetadataPath("main.tex"), false);
    assert.equal(isHostMetadataPath("comments.json"), false);
  });

  it("also blocks comments.json for guest file/fs writes", () => {
    assert.equal(isGuestForbiddenWritePath("comments.json"), true);
    assert.equal(isGuestForbiddenWritePath("Comments.JSON"), true);
    assert.equal(isGuestForbiddenWritePath("main.tex"), false);
  });

  it("blocks latexmk rc files and git metadata, including rename targets", () => {
    for (const rel of ["latexmkrc", ".latexmkrc", "notes/local.latexmkrc", ".git/config", ".git/hooks/pre-commit", ".GIT/config"]) {
      assert.equal(isGuestForbiddenWritePath(rel), true, rel);
    }
    const prefix = `/api/projects/${encodeURIComponent(session().projectId)}`;
    const renamed = guestRouteDenial(
      req(`${prefix}/fs/rename`, "POST", { from: "main.tex", to: "latexmkrc" }),
      session(),
    );
    assert.equal(renamed?.status, 403);
  });

  it("also blocks citations.json for guest file/fs writes (mirrors comments.json)", () => {
    assert.equal(isGuestForbiddenWritePath("citations.json"), true);
    assert.equal(isGuestForbiddenWritePath("Citations.JSON"), true);
  });
});

describe("guestRouteDenial", () => {
  const s = session();
  const prefix = `/api/projects/${encodeURIComponent(s.projectId)}`;

  it("allows GET of host metadata but not PUT", () => {
    assert.equal(guestRouteDenial(req(`${prefix}/files/openleaf.json`, "GET"), s), null);
    const putMeta = guestRouteDenial(req(`${prefix}/files/openleaf.json`, "PUT"), s);
    assert.equal(putMeta?.status, 403);
    const putRuntime = guestRouteDenial(req(`${prefix}/files/.openleaf/timeline.json`, "PUT"), s);
    assert.equal(putRuntime?.status, 403);
  });

  it("blocks guest writes to comments.json via the file API", () => {
    const denial = guestRouteDenial(req(`${prefix}/files/comments.json`, "PUT"), s);
    assert.equal(denial?.status, 403);
  });

  it("blocks guest writes to citations.json via the file API", () => {
    const denial = guestRouteDenial(req(`${prefix}/files/citations.json`, "PUT"), s);
    assert.equal(denial?.status, 403);
  });

  it("allows a write guest to save manuscript files", () => {
    assert.equal(guestRouteDenial(req(`${prefix}/files/main.tex`, "PUT"), s), null);
    assert.equal(guestRouteDenial(req(`${prefix}/fs/create`, "POST", { path: "notes.md" }), s), null);
  });

  it("blocks mkdir/rename onto host metadata", () => {
    const mkdir = guestRouteDenial(req(`${prefix}/fs/mkdir`, "POST", { path: ".openleaf/extra" }), s);
    assert.equal(mkdir?.status, 403);
    const rename = guestRouteDenial(
      req(`${prefix}/fs/rename`, "POST", { from: "main.tex", to: "openleaf.json" }),
      s,
    );
    assert.equal(rename?.status, 403);
  });

  it("blocks comment mutations on a read-only share", () => {
    const ro = session({ readOnly: true });
    const post = guestRouteDenial(req(`${prefix}/comments`, "POST", { body: "hi" }), ro);
    assert.equal(post?.status, 403);
    assert.match(post?.error ?? "", /read-only/i);
    assert.equal(guestRouteDenial(req(`${prefix}/comments`, "GET"), ro), null);
  });

  it("allows comment POST for a write share", () => {
    assert.equal(guestRouteDenial(req(`${prefix}/comments`, "POST"), s), null);
  });

  it("rejects other projects", () => {
    const denial = guestRouteDenial(req("/api/projects/other/tree", "GET"), s);
    assert.equal(denial?.status, 403);
  });

  it("gates track-changes generation on compile (preview does not need download)", () => {
    assert.equal(guestRouteDenial(req(`${prefix}/track-changes`, "POST"), s), null);
    const noCompile = session({ allowCompile: false });
    assert.equal(guestRouteDenial(req(`${prefix}/track-changes`, "POST"), noCompile)?.status, 403);
    const noDownload = session({ allowDownload: false });
    assert.equal(guestRouteDenial(req(`${prefix}/track-changes`, "POST"), noDownload), null);
  });
});
