import type {
  AppConfig,
  CommentAnchor,
  CommentThread,
  CompileResult,
  DiffHighlightsResult,
  FilePayload,
  GitCommitInfo,
  GitCommitResult,
  ProjectMeta,
  SynctexForwardHit,
  SynctexHit,
  TreeNode,
} from "./types";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/failed to fetch|networkerror|load failed/i.test(msg)) {
      throw new Error("Could not reach the OpenLeaf server — check that it is running, then try again");
    }
    throw err instanceof Error ? err : new Error(msg);
  }
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* ignore */
    }
    throw new Error(message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export function getConfig(): Promise<AppConfig> {
  return request("/api/config");
}

export function getProjectIdentities(
  projectId: string,
): Promise<Array<{ id: string; name: string; color: string }>> {
  return request(`/api/projects/${encodeURIComponent(projectId)}/identities`);
}

export function flushProjectCollab(
  id: string,
  opts?: { identityId?: string; message?: string; branchId?: string },
): Promise<{ ok: boolean; git?: GitCommitResult }> {
  return request(`/api/projects/${encodeURIComponent(id)}/collab/flush`, {
    method: "POST",
    body: JSON.stringify(opts ?? {}),
    headers: opts?.identityId ? { "X-OpenLeaf-Identity": opts.identityId } : undefined,
  });
}

export function ensureProjectCollabFile(id: string, filePath: string): Promise<{ ok: boolean; path: string }> {
  return request(`/api/projects/${encodeURIComponent(id)}/collab/ensure`, {
    method: "POST",
    body: JSON.stringify({ path: filePath }),
  });
}

export function listProjectHistory(id: string, limit = 50): Promise<GitCommitInfo[]> {
  return request(`/api/projects/${encodeURIComponent(id)}/history?limit=${limit}`);
}

export function getProjectTimeline(id: string, branchId?: string): Promise<import("./types").TimelineView> {
  const q = branchId ? `?branchId=${encodeURIComponent(branchId)}` : "";
  return request(`/api/projects/${encodeURIComponent(id)}/timeline${q}`);
}

export function commitProjectTimeline(
  id: string,
  body: { message: string; branchId?: string; identityId?: string },
): Promise<{
  timeline: import("./types").TimelineView;
  node: import("./types").TimelineNode;
  hash: string;
}> {
  return request(`/api/projects/${encodeURIComponent(id)}/timeline/commit`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: body.identityId ? { "X-OpenLeaf-Identity": body.identityId } : undefined,
  });
}

export function forkProjectTimeline(
  id: string,
  body: { fromNodeId: string; name: string },
): Promise<{ timeline: import("./types").TimelineView; branch: import("./types").TimelineBranch }> {
  return request(`/api/projects/${encodeURIComponent(id)}/timeline/fork`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function pruneProjectTimelineTip(
  id: string,
  body: { branchId: string; forceKickEditors?: boolean },
): Promise<{ ok: boolean; timeline: import("./types").TimelineView }> {
  return request(`/api/projects/${encodeURIComponent(id)}/timeline/prune`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export type PrunedTipInfo = {
  branchId: string;
  name: string;
  prunedAt: string;
  headNodeId: string | null;
  tipHash: string | null;
  tipMessage: string | null;
  nodeCount: number;
};

export function listProjectTimelineTrash(id: string): Promise<{ items: PrunedTipInfo[] }> {
  return request(`/api/projects/${encodeURIComponent(id)}/timeline/trash`);
}

export function unpruneProjectTimelineTip(
  id: string,
  body: { branchId: string },
): Promise<{ ok: boolean; timeline: import("./types").TimelineView }> {
  return request(`/api/projects/${encodeURIComponent(id)}/timeline/unprune`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function deleteProjectTimelineTrashForever(
  id: string,
  body: {
    branchId: string;
    confirmName: string;
    forceKickEditors?: boolean;
    discardDirty?: boolean;
  },
): Promise<{
  ok: true;
  timeline: import("./types").TimelineView;
  deleted: { branchId: string; name: string };
}> {
  return request(`/api/projects/${encodeURIComponent(id)}/timeline/trash/delete`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function checkoutProjectTimeline(
  id: string,
  body: { branchId?: string; nodeId?: string | null },
): Promise<import("./types").TimelineView> {
  return request(`/api/projects/${encodeURIComponent(id)}/timeline/checkout`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export type MergeConflictFile = {
  path: string;
  code: string;
  kind: "both-modified" | "both-added" | "deleted-by-us" | "deleted-by-them" | "other";
  resolved: boolean;
  strategy?: "ours" | "theirs" | "manual";
  binary?: boolean;
};

export type MergeSession = {
  id: string;
  projectId: string;
  targetBranchId: string;
  targetBranchName: string;
  sourceBranchId: string;
  sourceBranchName: string;
  targetHash: string;
  sourceHash: string;
  status: "in_progress" | "ready" | "completed" | "aborted";
  conflicts: MergeConflictFile[];
  autoMerged: string[];
  message: string;
  startedAt: string;
};

export type MergeFileSides = {
  path: string;
  binary: boolean;
  ours: string | null;
  theirs: string | null;
  base: string | null;
  working: string | null;
  resolved: boolean;
  strategy?: MergeConflictFile["strategy"];
};

export function startProjectMerge(
  id: string,
  body: { sourceBranchId: string; targetBranchId?: string },
): Promise<MergeSession> {
  return request(`/api/projects/${encodeURIComponent(id)}/timeline/merge/start`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function getProjectMerge(id: string): Promise<MergeSession | null> {
  const session = await request<MergeSession | undefined>(
    `/api/projects/${encodeURIComponent(id)}/timeline/merge`,
  );
  return session ?? null;
}

export function getProjectMergeFile(id: string, filePath: string): Promise<MergeFileSides> {
  return request(
    `/api/projects/${encodeURIComponent(id)}/timeline/merge/file?path=${encodeURIComponent(filePath)}`,
  );
}

export function resolveProjectMerge(
  id: string,
  body: { path: string; strategy: "ours" | "theirs" | "manual"; content?: string },
): Promise<MergeSession> {
  return request(`/api/projects/${encodeURIComponent(id)}/timeline/merge/resolve`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function completeProjectMerge(
  id: string,
  body?: { message?: string },
): Promise<{
  session: MergeSession;
  timeline: import("./types").TimelineView;
  hash: string;
  nodeId: string;
}> {
  return request(`/api/projects/${encodeURIComponent(id)}/timeline/merge/complete`, {
    method: "POST",
    body: JSON.stringify(body ?? {}),
  });
}

export function abortProjectMerge(
  id: string,
): Promise<{ ok: true; timeline: import("./types").TimelineView; targetBranchId: string }> {
  return request(`/api/projects/${encodeURIComponent(id)}/timeline/merge/abort`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function restoreProjectHistory(
  id: string,
  hash: string,
  identityId?: string,
): Promise<{ ok: boolean; git?: GitCommitResult }> {
  return request(`/api/projects/${encodeURIComponent(id)}/history/restore`, {
    method: "POST",
    body: JSON.stringify({ hash, identityId }),
    headers: identityId ? { "X-OpenLeaf-Identity": identityId } : undefined,
  });
}

export function getDiffHighlights(
  id: string,
  since?: string,
  branchId?: string,
  at?: string | null,
): Promise<DiffHighlightsResult> {
  const params = new URLSearchParams();
  if (since) params.set("since", since);
  if (branchId) params.set("branchId", branchId);
  if (at) params.set("at", at);
  const q = params.toString() ? `?${params}` : "";
  return request(`/api/projects/${encodeURIComponent(id)}/diff-highlights${q}`);
}

export type BranchLeafStat = {
  branchId: string;
  name: string;
  sacred: boolean;
  headNodeId: string | null;
  tipHash: string | null;
  dirty: boolean;
  additions: number;
  deletions: number;
  files: number;
};

export function getBranchLeaves(id: string): Promise<BranchLeafStat[]> {
  return request(`/api/projects/${encodeURIComponent(id)}/branch-leaves`);
}

export function patchConfig(body: Partial<AppConfig>): Promise<AppConfig> {
  return request("/api/config", { method: "PATCH", body: JSON.stringify(body) });
}

export function listProjects(): Promise<ProjectMeta[]> {
  return request("/api/projects");
}

export function getProject(id: string): Promise<ProjectMeta> {
  return request(`/api/projects/${encodeURIComponent(id)}`);
}

export function createProject(id: string, fromTemplate?: string): Promise<ProjectMeta> {
  return request("/api/projects", {
    method: "POST",
    body: JSON.stringify({ id, fromTemplate }),
  });
}

export function getTree(id: string, at?: string | null, branchId?: string | null): Promise<TreeNode[]> {
  const params = new URLSearchParams();
  if (at) params.set("at", at);
  if (branchId) params.set("branchId", branchId);
  const q = params.toString() ? `?${params}` : "";
  return request(`/api/projects/${encodeURIComponent(id)}/tree${q}`);
}

function fileUrl(id: string, filePath: string, query?: string): string {
  const segments = filePath
    .split("/")
    .filter(Boolean)
    .map((s) => encodeURIComponent(s))
    .join("/");
  const q = query ? `?${query}` : "";
  return `/api/projects/${encodeURIComponent(id)}/files/${segments}${q}`;
}

export function readProjectFile(
  id: string,
  filePath: string,
  opts?: { forceText?: boolean; at?: string | null; branchId?: string | null },
): Promise<FilePayload> {
  const params = new URLSearchParams();
  if (opts?.forceText) params.set("forceText", "1");
  if (opts?.at) params.set("at", opts.at);
  if (opts?.branchId) params.set("branchId", opts.branchId);
  const query = params.toString() || undefined;
  return request(fileUrl(id, filePath, query));
}

export function writeProjectFile(
  id: string,
  filePath: string,
  content: string,
  encoding: "utf8" | "base64" = "utf8",
): Promise<{ ok: boolean; path: string }> {
  return request(fileUrl(id, filePath), {
    method: "PUT",
    body: JSON.stringify({ content, encoding }),
  });
}

export function deleteProjectPath(
  id: string,
  filePath: string,
): Promise<{ ok: boolean; path: string }> {
  return request(fileUrl(id, filePath), { method: "DELETE" });
}

export function createProjectFile(
  id: string,
  filePath: string,
  content = "",
): Promise<{ ok: boolean; path: string }> {
  return request(`/api/projects/${encodeURIComponent(id)}/fs/create`, {
    method: "POST",
    body: JSON.stringify({ path: filePath, content }),
  });
}

export function mkdirProjectPath(
  id: string,
  dirPath: string,
): Promise<{ ok: boolean; path: string }> {
  return request(`/api/projects/${encodeURIComponent(id)}/fs/mkdir`, {
    method: "POST",
    body: JSON.stringify({ path: dirPath }),
  });
}

export function renameProjectPath(
  id: string,
  from: string,
  to: string,
): Promise<{ ok: boolean; from: string; to: string }> {
  return request(`/api/projects/${encodeURIComponent(id)}/fs/rename`, {
    method: "POST",
    body: JSON.stringify({ from, to }),
  });
}

export function pdfUrl(id: string, bust?: number, branchId?: string): string {
  const params = new URLSearchParams();
  if (bust != null) params.set("t", String(bust));
  if (branchId) params.set("branchId", branchId);
  const q = params.toString() ? `?${params}` : "";
  return `/api/projects/${encodeURIComponent(id)}/pdf${q}`;
}

export function downloadUrl(id: string, format: "pdf" | "zip", branchId?: string): string {
  const params = new URLSearchParams({ format });
  if (branchId) params.set("branchId", branchId);
  return `/api/projects/${encodeURIComponent(id)}/download?${params}`;
}

export function synctexLookup(
  id: string,
  page: number,
  x: number,
  y: number,
  branchId?: string,
): Promise<SynctexHit> {
  const params = new URLSearchParams({
    direction: "reverse",
    page: String(page),
    x: String(x),
    y: String(y),
  });
  if (branchId) params.set("branchId", branchId);
  return request(`/api/projects/${encodeURIComponent(id)}/synctex?${params}`);
}

export function synctexForward(
  id: string,
  file: string,
  line: number,
  column = 1,
  branchId?: string,
): Promise<SynctexForwardHit> {
  const params = new URLSearchParams({
    direction: "forward",
    file,
    line: String(line),
    column: String(column),
  });
  if (branchId) params.set("branchId", branchId);
  return request(`/api/projects/${encodeURIComponent(id)}/synctex?${params}`);
}

export function listProjectComments(id: string): Promise<CommentThread[]> {
  return request(`/api/projects/${encodeURIComponent(id)}/comments`);
}

export function createProjectComment(
  id: string,
  body: { identityId: string; body: string; anchor: CommentAnchor },
): Promise<{ thread: CommentThread; git?: GitCommitResult }> {
  return request(`/api/projects/${encodeURIComponent(id)}/comments`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "X-OpenLeaf-Identity": body.identityId },
  });
}

export function replyProjectComment(
  id: string,
  commentId: string,
  body: { identityId: string; body: string },
): Promise<{ thread: CommentThread; git?: GitCommitResult }> {
  return request(
    `/api/projects/${encodeURIComponent(id)}/comments/${encodeURIComponent(commentId)}/replies`,
    {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "X-OpenLeaf-Identity": body.identityId },
    },
  );
}

export function patchProjectComment(
  id: string,
  commentId: string,
  body: { identityId?: string; resolved?: boolean; body?: string },
): Promise<{ thread: CommentThread; git?: GitCommitResult }> {
  return request(
    `/api/projects/${encodeURIComponent(id)}/comments/${encodeURIComponent(commentId)}`,
    {
      method: "PATCH",
      body: JSON.stringify(body),
      headers: body.identityId ? { "X-OpenLeaf-Identity": body.identityId } : undefined,
    },
  );
}

export function deleteProjectComment(
  id: string,
  commentId: string,
  identityId?: string,
): Promise<{ ok: boolean; git?: GitCommitResult }> {
  return request(
    `/api/projects/${encodeURIComponent(id)}/comments/${encodeURIComponent(commentId)}`,
    {
      method: "DELETE",
      headers: identityId ? { "X-OpenLeaf-Identity": identityId } : undefined,
    },
  );
}

export type CompileHandlers = {
  onLog?: (chunk: string) => void;
  onStatus?: (state: string) => void;
};

export function compileProject(
  id: string,
  handlers: CompileHandlers = {},
  opts?: { branchId?: string },
): Promise<CompileResult> {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({ stream: "1" });
    if (opts?.branchId) params.set("branchId", opts.branchId);
    fetch(`/api/projects/${encodeURIComponent(id)}/compile?${params}`, {
      method: "POST",
      headers: { Accept: "text/event-stream" },
    })
      .then(async (res) => {
        if (!res.ok || !res.body) {
          throw new Error("Compile request failed");
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let result: CompileResult | null = null;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split("\n\n");
          buffer = parts.pop() ?? "";
          for (const part of parts) {
            const lines = part.split("\n");
            let event = "message";
            let data = "";
            for (const line of lines) {
              if (line.startsWith("event:")) event = line.slice(6).trim();
              if (line.startsWith("data:")) data += line.slice(5).trim();
            }
            if (!data) continue;
            const parsed = JSON.parse(data) as Record<string, unknown>;
            if (event === "log" && typeof parsed.chunk === "string") {
              handlers.onLog?.(parsed.chunk);
            } else if (event === "status" && typeof parsed.state === "string") {
              handlers.onStatus?.(parsed.state);
            } else if (event === "done") {
              result = parsed as unknown as CompileResult;
            } else if (event === "error") {
              throw new Error(String(parsed.error ?? "Compile failed"));
            }
          }
        }
        if (!result) throw new Error("Compile ended without result");
        resolve(result);
      })
      .catch(reject);
  });
}
