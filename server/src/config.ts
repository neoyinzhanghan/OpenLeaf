import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const LatexConfigSchema = z.object({
  engine: z.enum(["pdflatex", "xelatex"]).default("pdflatex"),
  autoCompile: z.boolean().default(true),
  timeoutMs: z.number().int().positive().default(120_000),
  outputDir: z.string().default(".openleaf/out"),
});

const IdentitySchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9._-]+$/),
  name: z.string().min(1),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
});

export { IdentitySchema };

const CollabConfigSchema = z.object({
  flushMs: z.number().int().positive().default(750),
  persistYjs: z.boolean().default(true),
});

const GitConfigSchema = z.object({
  enabled: z.boolean().default(true),
});

const AppConfigSchema = z
  .object({
    host: z.string().default("127.0.0.1"),
    port: z.number().int().positive().default(8787),
    projectsRoot: z.string().default("projects"),
    latex: LatexConfigSchema.default({}),
    client: z
      .object({
        devPort: z.number().int().positive().default(5173),
      })
      .default({}),
    /** Seeded into new projects' openleaf.json — not used at runtime for collab. */
    defaultIdentities: z.array(IdentitySchema).default([]),
    /** @deprecated use defaultIdentities; still accepted for backwards compatibility */
    identities: z.array(IdentitySchema).optional(),
    collab: CollabConfigSchema.default({}),
    git: GitConfigSchema.default({}),
  })
  .superRefine((cfg, ctx) => {
    const list = cfg.defaultIdentities.length > 0 ? cfg.defaultIdentities : cfg.identities ?? [];
    const seen = new Set<string>();
    for (const [i, id] of list.entries()) {
      if (seen.has(id.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate identity id: ${id.id}`,
          path: ["defaultIdentities", i, "id"],
        });
      }
      seen.add(id.id);
    }
  });

export type AppConfig = z.infer<typeof AppConfigSchema>;
export type Identity = z.infer<typeof IdentitySchema>;
export type LatexEngine = AppConfig["latex"]["engine"];

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Repo root (parent of server/) */
export const REPO_ROOT = path.resolve(__dirname, "../..");
export const CONFIG_DIR = path.join(REPO_ROOT, "config");
const DEFAULT_PATH = path.join(CONFIG_DIR, "default.json");
const LOCAL_PATH = path.join(CONFIG_DIR, "local.json");

function readJsonIfExists(filePath: string): unknown {
  if (!fs.existsSync(filePath)) return {};
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
}

function deepMerge<T extends Record<string, unknown>>(base: T, overlay: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      base[key] &&
      typeof base[key] === "object" &&
      !Array.isArray(base[key])
    ) {
      out[key] = deepMerge(base[key] as Record<string, unknown>, value as Record<string, unknown>);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out as T;
}

function applyEnv(config: AppConfig): AppConfig {
  const defaults =
    config.defaultIdentities.length > 0
      ? config.defaultIdentities
      : config.identities ?? [];
  const next = {
    ...config,
    latex: { ...config.latex },
    client: { ...config.client },
    collab: { ...config.collab },
    git: { ...config.git },
    defaultIdentities: [...defaults],
    identities: undefined,
  };
  if (process.env.OPENLEAF_HOST) next.host = process.env.OPENLEAF_HOST;
  if (process.env.OPENLEAF_PORT) next.port = Number(process.env.OPENLEAF_PORT);
  if (process.env.OPENLEAF_PROJECTS_ROOT) next.projectsRoot = process.env.OPENLEAF_PROJECTS_ROOT;
  if (process.env.OPENLEAF_ENGINE === "pdflatex" || process.env.OPENLEAF_ENGINE === "xelatex") {
    next.latex.engine = process.env.OPENLEAF_ENGINE;
  }
  return next;
}

let cached: AppConfig | null = null;

export function loadConfig(force = false): AppConfig {
  if (cached && !force) return cached;
  const defaults = readJsonIfExists(DEFAULT_PATH) as Record<string, unknown>;
  const local = readJsonIfExists(LOCAL_PATH) as Record<string, unknown>;
  const merged = deepMerge(defaults, local);
  const parsed = AppConfigSchema.parse(merged);
  cached = applyEnv(parsed);
  return cached;
}

export function getProjectsRootAbs(): string {
  const cfg = loadConfig();
  return path.isAbsolute(cfg.projectsRoot)
    ? cfg.projectsRoot
    : path.resolve(REPO_ROOT, cfg.projectsRoot);
}

const PatchSchema = z
  .object({
    host: z.string().optional(),
    port: z.number().int().positive().optional(),
    projectsRoot: z.string().optional(),
    latex: LatexConfigSchema.partial().optional(),
    client: z
      .object({
        devPort: z.number().int().positive().optional(),
      })
      .optional(),
    identities: z.array(IdentitySchema).optional(),
    defaultIdentities: z.array(IdentitySchema).optional(),
    collab: CollabConfigSchema.partial().optional(),
    git: GitConfigSchema.partial().optional(),
  })
  .strict();

export function patchConfig(body: unknown): AppConfig {
  const patch = PatchSchema.parse(body);
  const existingLocal = (readJsonIfExists(LOCAL_PATH) as Record<string, unknown>) ?? {};
  const nextLocal = deepMerge(existingLocal, patch as Record<string, unknown>);
  if (patch.defaultIdentities) nextLocal.defaultIdentities = patch.defaultIdentities;
  if (patch.identities && !patch.defaultIdentities) nextLocal.defaultIdentities = patch.identities;
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(LOCAL_PATH, `${JSON.stringify(nextLocal, null, 2)}\n`, "utf8");
  return loadConfig(true);
}

export function getPublicConfig(): AppConfig {
  return loadConfig();
}

/** Defaults used when creating new projects (not for live collab auth). */
export function getDefaultIdentities(): Identity[] {
  return loadConfig().defaultIdentities;
}
