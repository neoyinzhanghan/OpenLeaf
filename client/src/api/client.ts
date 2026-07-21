import type {
  AppConfig,
  CompileResult,
  FilePayload,
  GitCommitInfo,
  GitCommitResult,
  ProjectMeta,
  SynctexForwardHit,
  SynctexHit,
  TreeNode,
} from "./types";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
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
  opts?: { identityId?: string; message?: string },
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

export function getTree(id: string): Promise<TreeNode[]> {
  return request(`/api/projects/${encodeURIComponent(id)}/tree`);
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
  opts?: { forceText?: boolean },
): Promise<FilePayload> {
  const query = opts?.forceText ? "forceText=1" : undefined;
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

export function pdfUrl(id: string, bust?: number): string {
  const q = bust != null ? `?t=${bust}` : "";
  return `/api/projects/${encodeURIComponent(id)}/pdf${q}`;
}

export function downloadUrl(id: string, format: "pdf" | "zip"): string {
  return `/api/projects/${encodeURIComponent(id)}/download?format=${format}`;
}

export function synctexLookup(
  id: string,
  page: number,
  x: number,
  y: number,
): Promise<SynctexHit> {
  const params = new URLSearchParams({
    direction: "reverse",
    page: String(page),
    x: String(x),
    y: String(y),
  });
  return request(`/api/projects/${encodeURIComponent(id)}/synctex?${params}`);
}

export function synctexForward(
  id: string,
  file: string,
  line: number,
  column = 1,
): Promise<SynctexForwardHit> {
  const params = new URLSearchParams({
    direction: "forward",
    file,
    line: String(line),
    column: String(column),
  });
  return request(`/api/projects/${encodeURIComponent(id)}/synctex?${params}`);
}

export type CompileHandlers = {
  onLog?: (chunk: string) => void;
  onStatus?: (state: string) => void;
};

export function compileProject(
  id: string,
  handlers: CompileHandlers = {},
): Promise<CompileResult> {
  return new Promise((resolve, reject) => {
    fetch(`/api/projects/${encodeURIComponent(id)}/compile?stream=1`, {
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
