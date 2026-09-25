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

/** Display name (collaboration) is separate from the host login username. */
const UserConfigObject = z.object({
  displayName: z.string().min(1).max(80).optional(),
  /** Operator account for the public host URL. Not a collab identity. */
  hostUsername: z
    .string()
    .regex(/^[a-zA-Z0-9._-]+$/)
    .optional(),
});
const UserConfigSchema = UserConfigObject.default({});

const AccessSchema = z.enum(["localhost", "lan", "remote"]);

const AppConfigSchema = z
  .object({
    host: z.string().default("127.0.0.1"),
    port: z.number().int().positive().default(8787),
    projectsRoot: z.string().default("projects"),
    /** Sibling of projectsRoot — personal citation library (papers/<citekey>/record.json). */
    libraryRoot: z.string().default("library"),
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
    /** Who you are when collaborating. Does not grant host login. */
    user: UserConfigSchema,
    /**
     * How setup bound this install.
     * Omitted on older installs — do not infer a bind-address change from absence.
     */
    access: AccessSchema.optional(),
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
export type AccessMode = z.infer<typeof AccessSchema>;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Checkout root (parent of server/). Ignores OPENLEAF_REPO_ROOT. */
export const REPO_ROOT = path.resolve(__dirname, "../..");
/** Checkout config directory. Ignores OPENLEAF_CONFIG_DIR. */
export const CONFIG_DIR = path.join(REPO_ROOT, "config");

/** Active install root. Tests and extra instances set OPENLEAF_REPO_ROOT. */
export function getRepoRoot(): string {
  const override = process.env.OPENLEAF_REPO_ROOT?.trim();
  return override ? path.resolve(override) : REPO_ROOT;
}

/** Active config directory. Tests set OPENLEAF_CONFIG_DIR. */
export function getConfigDir(): string {
  const override = process.env.OPENLEAF_CONFIG_DIR?.trim();
  return override ? path.resolve(override) : path.join(getRepoRoot(), "config");
}

function defaultPath(): string {
  return path.join(getConfigDir(), "default.json");
}

function localPath(): string {
  return path.join(getConfigDir(), "local.json");
}

/** Write a file by renaming a temp sibling so readers never see a partial file. */
export function writeFileAtomic(filePath: string, contents: string, mode = 0o644): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, contents, { encoding: "utf8", mode });
  try {
    fs.renameSync(tmp, filePath);
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? String(err.code) : "";
    if (code === "EPERM" || code === "EEXIST" || code === "EBUSY") {
      fs.rmSync(filePath, { force: true });
      fs.renameSync(tmp, filePath);
    } else {
      fs.rmSync(tmp, { force: true });
      throw err;
    }
  }
  try {
    fs.chmodSync(filePath, mode);
  } catch {
    /* windows */
  }
}

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
    user: { ...config.user },
    collab: { ...config.collab },
    git: { ...config.git },
    defaultIdentities: [...defaults],
    identities: undefined,
  };
  if (process.env.OPENLEAF_HOST) next.host = process.env.OPENLEAF_HOST;
  if (process.env.OPENLEAF_PORT) next.port = Number(process.env.OPENLEAF_PORT);
  if (process.env.OPENLEAF_PROJECTS_ROOT) next.projectsRoot = process.env.OPENLEAF_PROJECTS_ROOT;
  if (process.env.OPENLEAF_LIBRARY_ROOT) next.libraryRoot = process.env.OPENLEAF_LIBRARY_ROOT;
  if (process.env.OPENLEAF_ENGINE === "pdflatex" || process.env.OPENLEAF_ENGINE === "xelatex") {
    next.latex.engine = process.env.OPENLEAF_ENGINE;
  }
  const display = process.env.OPENLEAF_DISPLAY_NAME?.trim();
  if (display) next.user.displayName = display;
  const hostUser = process.env.OPENLEAF_HOST_USER?.trim();
  if (hostUser && /^[a-zA-Z0-9._-]+$/.test(hostUser)) next.user.hostUsername = hostUser;
  return next;
}

/** Collaboration identity derived from a display name. Not a host login. */
export function identityFromDisplayName(displayName: string): Identity {
  const name = displayName.trim();
  let id = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  if (!id || !/^[a-zA-Z0-9._-]+$/.test(id)) id = "author";
  return { id, name, color: "#0F766E" };
}

let cached: AppConfig | null = null;

export function loadConfig(force = false): AppConfig {
  if (cached && !force) return cached;
  const defaults = readJsonIfExists(defaultPath()) as Record<string, unknown>;
  const local = readJsonIfExists(localPath()) as Record<string, unknown>;
  const merged = deepMerge(defaults, local);
  const parsed = AppConfigSchema.parse(merged);
  cached = applyEnv(parsed);
  return cached;
}

export function tryParseAppConfig(
  raw: unknown,
): { ok: true; config: AppConfig } | { ok: false; message: string } {
  const parsed = AppConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    return { ok: false, message };
  }
  return { ok: true, config: parsed.data };
}

/** Raw local.json object, including keys the schema does not know about. */
export function readLocalConfigRaw(): Record<string, unknown> {
  const raw = readJsonIfExists(localPath());
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return raw as Record<string, unknown>;
}

export function getProjectsRootAbs(): string {
  const cfg = loadConfig();
  return path.isAbsolute(cfg.projectsRoot)
    ? cfg.projectsRoot
    : path.resolve(getRepoRoot(), cfg.projectsRoot);
}

export function getLibraryRootAbs(): string {
  const cfg = loadConfig();
  return path.isAbsolute(cfg.libraryRoot)
    ? cfg.libraryRoot
    : path.resolve(getRepoRoot(), cfg.libraryRoot);
}

const PatchSchema = z
  .object({
    host: z.string().optional(),
    port: z.number().int().positive().optional(),
    projectsRoot: z.string().optional(),
    libraryRoot: z.string().optional(),
    latex: LatexConfigSchema.partial().optional(),
    client: z
      .object({
        devPort: z.number().int().positive().optional(),
      })
      .optional(),
    identities: z.array(IdentitySchema).optional(),
    defaultIdentities: z.array(IdentitySchema).optional(),
    user: UserConfigObject.partial().optional(),
    access: AccessSchema.optional(),
    collab: CollabConfigSchema.partial().optional(),
    git: GitConfigSchema.partial().optional(),
  })
  .strict();

export function patchConfig(body: unknown): AppConfig {
  const patch = PatchSchema.parse(body);
  if (Object.keys(patch).length === 0) return loadConfig();
  const existingLocal = readLocalConfigRaw();
  const nextLocal = deepMerge(existingLocal, patch as Record<string, unknown>);
  if (patch.defaultIdentities) nextLocal.defaultIdentities = patch.defaultIdentities;
  if (patch.identities && !patch.defaultIdentities) nextLocal.defaultIdentities = patch.identities;
  if (patch.user) {
    const prev =
      existingLocal.user && typeof existingLocal.user === "object" && !Array.isArray(existingLocal.user)
        ? (existingLocal.user as Record<string, unknown>)
        : {};
    nextLocal.user = { ...prev, ...patch.user };
  }
  writeFileAtomic(localPath(), `${JSON.stringify(nextLocal, null, 2)}\n`);
  return loadConfig(true);
}

export function getPublicConfig(): AppConfig {
  return loadConfig();
}

/** Defaults used when creating new projects (not for live collab auth). */
export function getDefaultIdentities(): Identity[] {
  const cfg = loadConfig();
  if (cfg.defaultIdentities.length > 0) return cfg.defaultIdentities;
  const display = cfg.user?.displayName?.trim();
  if (display) return [identityFromDisplayName(display)];
  return [];
}
