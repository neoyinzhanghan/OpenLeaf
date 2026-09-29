import http from "node:http";
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

test.describe.configure({ mode: "serial" });

type Raw = { status: number; headers: http.IncomingHttpHeaders; body: string };

function request(
  method: string,
  urlPath: string,
  opts?: { host?: string; cookie?: string; json?: unknown; origin?: string },
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
          Origin: opts?.origin ?? `${base.protocol}//${host}`,
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
          ...(opts?.cookie ? { Cookie: opts.cookie } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk as Buffer));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
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

async function createProject(id: string): Promise<void> {
  const res = await request("POST", "/api/projects", { json: { id } });
  expect(res.status, res.body).toBe(201);
}

test("share guest can edit and compile, and cannot leave the project", async () => {
  const id = "flow-share";
  await createProject(id);
  const started = await request("POST", `/api/projects/${id}/share`, {
    json: {
      branchId: "main",
      allowMainShare: true,
      ttlMinutes: 30,
      readOnly: false,
      allowCompile: true,
      allowDownload: true,
    },
  });
  expect(started.status, started.body).toBe(201);
  let session = JSON.parse(started.body).session as {
    status: string;
    url: string;
    hostname: string;
    username: string;
    password: string;
    inviteUrl: string;
  };
  const deadline = Date.now() + 20_000;
  while (session.status !== "active" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const polled = await request("GET", `/api/projects/${id}/share?branchId=main`);
    session = JSON.parse(polled.body).session ?? session;
  }
  expect(session.status, JSON.stringify(session)).toBe("active");
  expect(session.hostname).toContain("trycloudflare.com");
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
  const guestCookie = cookieJar(login.headers, cookies);
  const write = await request("PUT", `/api/projects/${id}/files/notes.tex`, {
    host: session.hostname,
    cookie: guestCookie,
    json: { content: "% guest note\n" },
  });
  expect(write.status, write.body).toBeLessThan(400);
  const compiled = await request("POST", `/api/projects/${id}/compile`, {
    host: session.hostname,
    cookie: guestCookie,
    json: {},
  });
  expect(compiled.status, compiled.body).toBeLessThan(500);
  for (const target of ["latexmkrc", ".latexmkrc", ".git/config", "openleaf.json", "comments.json"]) {
    const denied = await request("PUT", `/api/projects/${id}/files/${target}`, {
      host: session.hostname,
      cookie: guestCookie,
      json: { content: "nope\n" },
    });
    expect(denied.status, target).toBe(403);
  }
  const created = await request("POST", `/api/projects/${id}/fs/create`, {
    host: session.hostname,
    cookie: guestCookie,
    json: { path: "latexmkrc" },
  });
  expect(created.status).toBe(403);
  const made = await request("POST", `/api/projects/${id}/fs/mkdir`, {
    host: session.hostname,
    cookie: guestCookie,
    json: { path: ".git/hooks" },
  });
  expect(made.status).toBe(403);
  const renamed = await request("POST", `/api/projects/${id}/fs/rename`, {
    host: session.hostname,
    cookie: guestCookie,
    json: { from: "main.tex", to: "openleaf.json" },
  });
  expect(renamed.status).toBe(403);
  const other = await request("GET", "/api/projects", { host: session.hostname, cookie: guestCookie });
  expect(other.status).toBe(403);
  const config = await request("GET", "/api/config", { host: session.hostname, cookie: guestCookie });
  expect(config.status).toBe(403);
  const library = await request("GET", "/api/library/papers", { host: session.hostname, cookie: guestCookie });
  expect(library.status).toBe(403);
  const guest = JSON.parse(login.body).guest as { id: string };
  const kicked = await request("DELETE", `/api/projects/${id}/share/guests/${guest.id}?branchId=main`);
  expect(kicked.status, kicked.body).toBe(200);
  const stopped = await request("DELETE", `/api/projects/${id}/share?branchId=main`);
  expect(stopped.status).toBe(200);
});

test("synctex, zip, and pdf download answer for a compiled project", async () => {
  const id = "flow-files";
  await createProject(id);
  const compiled = await request("POST", `/api/projects/${id}/compile`, { json: {} });
  expect(compiled.status, compiled.body).toBeLessThan(500);
  const forward = await request("GET", `/api/projects/${id}/synctex?direction=forward&file=main.tex&line=1`);
  expect(forward.status).toBeLessThan(500);
  const zip = await request("GET", `/api/projects/${id}/download?format=zip`);
  expect(zip.status, zip.body.slice(0, 200)).toBe(200);
  const pdf = await request("GET", `/api/projects/${id}/download?format=pdf`);
  expect(pdf.status).toBe(200);
});

test("timeline commit, fork, and track-changes message", async () => {
  const id = "flow-timeline";
  await createProject(id);
  const current = JSON.parse((await request("GET", `/api/projects/${id}/files/main.tex`)).body) as {
    content?: string;
  };
  const edited = await request("PUT", `/api/projects/${id}/files/main.tex`, {
    json: { content: `${current.content ?? ""}% timeline checkpoint\n` },
  });
  expect(edited.status, edited.body).toBeLessThan(400);
  const committed = await request("POST", `/api/projects/${id}/timeline/commit`, {
    json: { message: "checkpoint", branchId: "main" },
  });
  expect(committed.status, committed.body).toBeLessThan(400);
  const timeline = JSON.parse((await request("GET", `/api/projects/${id}/timeline`)).body) as {
    nodes?: Array<{ id: string }>;
    branches?: Array<{ id: string }>;
  };
  const nodeId = timeline.nodes?.[0]?.id;
  expect(nodeId, JSON.stringify(timeline).slice(0, 400)).toBeTruthy();
  const forked = await request("POST", `/api/projects/${id}/timeline/fork`, {
    json: { fromNodeId: nodeId, name: "side" },
  });
  expect(forked.status, forked.body).toBe(201);
  const side = JSON.parse(forked.body) as { branch?: { id: string }; branchId?: string };
  const source = side.branch?.id ?? side.branchId;
  expect(source).toBeTruthy();
  const switched = await request("POST", `/api/projects/${id}/timeline/checkout`, { json: { branchId: "main" } });
  expect(switched.status, switched.body).toBeLessThan(400);
  const merged = await request("POST", `/api/projects/${id}/timeline/merge/start`, {
    json: { sourceBranchId: source, targetBranchId: "main" },
  });
  expect(merged.status, merged.body).toBeLessThan(500);
  const view = JSON.parse((await request("GET", `/api/projects/${id}/timeline`)).body) as {
    nodes?: Array<{ gitHash?: string }>;
  };
  const hashes = (view.nodes ?? []).map((node) => node.gitHash).filter(Boolean) as string[];
  if (hashes.length >= 2) {
    const track = await request("POST", `/api/projects/${id}/track-changes`, {
      json: { from: hashes[0], to: hashes[1] },
    });
    const text = track.body;
    if (track.status === 501) expect(text).toMatch(/latexdiff is not installed/);
    else expect(track.status).toBeLessThan(500);
  }
});

test("comments can be added, replied to, and resolved", async () => {
  const id = "flow-comments";
  await createProject(id);
  const identities = JSON.parse((await request("GET", `/api/projects/${id}/identities`)).body) as Array<{
    id: string;
  }>;
  const identityId = identities[0]?.id ?? "test-user";
  const created = await request("POST", `/api/projects/${id}/comments`, {
    json: { identityId, body: "Check this line", anchor: { file: "main.tex", line: 1 } },
  });
  expect(created.status, created.body).toBe(201);
  const thread = JSON.parse(created.body).thread as { id: string };
  const replied = await request("POST", `/api/projects/${id}/comments/${thread.id}/replies`, {
    json: { identityId, body: "Done" },
  });
  expect(replied.status, replied.body).toBeLessThan(400);
  const resolved = await request("PATCH", `/api/projects/${id}/comments/${thread.id}`, {
    json: { identityId, resolved: true },
  });
  expect(resolved.status, resolved.body).toBeLessThan(400);
});

test("library import, export, and an offline link error", async () => {
  const bib = await request("POST", "/api/library/import/bibtex", {
    json: {
      bibtex: "@article{Ada2020,\n  title={A paper},\n  author={Lovelace, Ada},\n  year={2020},\n  journal={Example}\n}\n",
    },
  });
  expect(bib.status, bib.body).toBeLessThan(400);
  const imported = JSON.parse(bib.body) as { imported?: Array<{ citekey: string }> };
  expect(imported.imported?.length ?? 0, bib.body).toBeGreaterThan(0);
  const offline = await request("POST", "/api/library/import/link", {
    json: { link: "https://127.0.0.1:9/not-a-paper" },
  });
  expect(offline.status).toBeGreaterThanOrEqual(400);
  expect(offline.body).not.toMatch(/at async/);
  const exported = await request("POST", "/api/library/export", {
    json: { citekeys: [imported.imported![0]!.citekey] },
  });
  expect(exported.status, exported.body).toBeLessThan(400);
});

test("an AI collaborator link can be minted and revoked", async () => {
  const id = "flow-ai";
  await createProject(id);
  const minted = await request("POST", `/api/projects/${id}/ai`, {
    json: { branchId: "main", slug: "helper", ttlMinutes: 30 },
  });
  expect(minted.status, minted.body).toBe(201);
  const ai = JSON.parse(minted.body).ai as { id: string };
  const revoked = await request("DELETE", `/api/projects/${id}/ai/${ai.id}`);
  expect(revoked.status, revoked.body).toBeLessThan(400);
});

test("a 10 MB tex file can be saved", async () => {
  const id = "flow-large";
  await createProject(id);
  const content = `% large\n${"A".repeat(10 * 1024 * 1024)}\n`;
  const saved = await request("PUT", `/api/projects/${id}/files/large.tex`, { json: { content } });
  expect(saved.status, saved.body.slice(0, 300)).toBeLessThan(400);
  const onDisk = fs.readFileSync(path.join(instance.projects, id, "large.tex"), "utf8");
  expect(onDisk.length).toBeGreaterThan(10 * 1024 * 1024);
});
