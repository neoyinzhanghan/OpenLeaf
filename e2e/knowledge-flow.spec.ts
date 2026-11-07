import { expect, test } from "@playwright/test";
import { startInstance, type Instance } from "./instance";

let instance: Instance;

test.beforeAll(async () => {
  instance = await startInstance();
});

test.afterAll(async () => {
  await instance.stop();
});

async function api(path: string, init?: RequestInit) {
  const res = await fetch(`${instance.baseURL}${path}`, {
    ...init,
    headers: {
      Origin: instance.baseURL,
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { res, body };
}

test("create knowledge item, review step, edit → needs-review; tree + inbox load", async ({
  page,
}) => {
  const created = await api("/api/knowledge/items", {
    method: "POST",
    body: JSON.stringify({ title: "DEMO e2e aspirates", knowledgeId: "demo-e2e-aspirates" }),
  });
  expect(created.res.status).toBe(201);
  const projectId = (created.body as { project: { id: string }; knowledgeId: string }).project.id;
  const knowledgeId = (created.body as { knowledgeId: string }).knowledgeId;
  expect(knowledgeId).toBeTruthy();

  const tex = `\\documentclass{article}
\\usepackage{openleaf-knowledge}
\\begin{document}
\\begin{knowledge}[result=count]{DEMO e2e aspirates}
\\begin{assumption}[base]
\\set{base}{100}
\\end{assumption}
\\begin{calculation}{count}
\\out{base}
\\end{calculation}
\\conclusion{Count \\out{count}.}
\\end{knowledge}
\\end{document}
`;
  const put = await api(`/api/projects/${encodeURIComponent(projectId)}/files/main.tex`, {
    method: "PUT",
    body: JSON.stringify({ content: tex }),
  });
  expect(put.res.ok).toBeTruthy();

  const check1 = await api(`/api/projects/${encodeURIComponent(projectId)}/knowledge/check`, {
    method: "POST",
    body: "{}",
  });
  expect(check1.res.ok).toBeTruthy();
  const steps1 = (check1.body as { steps: Array<{ id: string; status: string }> }).steps;
  expect(steps1.some((s) => s.id === "calculation:count")).toBeTruthy();

  const review = await api(`/api/projects/${encodeURIComponent(projectId)}/knowledge/review`, {
    method: "POST",
    body: JSON.stringify({ stepId: "calculation:count", verdict: "reviewed" }),
  });
  expect(review.res.ok).toBeTruthy();

  const check2 = await api(`/api/projects/${encodeURIComponent(projectId)}/knowledge/check`, {
    method: "POST",
    body: "{}",
  });
  expect(
    (check2.body as { steps: Array<{ id: string; status: string }> }).steps.find(
      (s) => s.id === "calculation:count",
    )?.status,
  ).toBe("reviewed");

  const edited = tex.replace("\\out{base}", "\\out{base} + 0");
  await api(`/api/projects/${encodeURIComponent(projectId)}/files/main.tex`, {
    method: "PUT",
    body: JSON.stringify({ content: edited }),
  });
  const check3 = await api(`/api/projects/${encodeURIComponent(projectId)}/knowledge/check`, {
    method: "POST",
    body: "{}",
  });
  expect(
    (check3.body as { steps: Array<{ id: string; status: string }> }).steps.find(
      (s) => s.id === "calculation:count",
    )?.status,
  ).toBe("needs-review");

  // Ordinary paper project citing knowledge
  const paperId = `demo-e2e-paper-${Date.now()}`;
  const paperProj = await api("/api/projects", {
    method: "POST",
    body: JSON.stringify({ id: paperId }),
  });
  expect(paperProj.res.ok || paperProj.res.status === 201).toBeTruthy();
  await api(`/api/projects/${encodeURIComponent(paperId)}/files/main.tex`, {
    method: "PUT",
    body: JSON.stringify({
      content: `\\documentclass{article}
\\usepackage{openleaf-knowledge}
\\begin{document}
Value \\kn{${knowledgeId}}.
\\end{document}
`,
    }),
  });

  // Allow graph mtime cache bucket to roll
  await new Promise((r) => setTimeout(r, 2100));
  const items = await api("/api/knowledge/items");
  expect(
    (items.body as { items: Array<{ knowledgeId: string }> }).items.some((i) => i.knowledgeId === knowledgeId),
  ).toBeTruthy();
  const graph = await api("/api/knowledge/graph");
  expect(graph.res.ok).toBeTruthy();
  expect(
    (graph.body as { nodes: Array<{ id: string }> }).nodes.some((n) => n.id === `kn:${knowledgeId}`),
  ).toBeTruthy();

  await page.goto(`${instance.baseURL}/p/${encodeURIComponent(projectId)}`);
  await expect(page.locator(".toolbar-knowledge-crumb, .editor-toolbar").first()).toBeVisible({
    timeout: 20_000,
  });

  await page.goto(`${instance.baseURL}/knowledge`);
  await expect(page.locator(".knowledge-canvas, .knowledge-main").first()).toBeVisible({
    timeout: 20_000,
  });

  await page.goto(`${instance.baseURL}/review`);
  await expect(page.locator("h1, .review-group, .empty-hint").first()).toBeVisible({ timeout: 20_000 });
});

test("tree search and filters visible", async ({ page }) => {
  await page.goto(`${instance.baseURL}/knowledge`);
  await expect(page.locator(".knowledge-main, .knowledge-canvas").first()).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.locator(".knowledge-toolbar").first()).toBeVisible();
});
