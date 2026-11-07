/**
 * Fact key generation and validation. Pure — no I/O. Spec §4.1.
 */

export const FACT_KEY_RE = /^[a-z][a-z0-9-]{1,63}$/;

export function isValidFactKey(key: string): boolean {
  return FACT_KEY_RE.test(key);
}

const ACRONYMS = new Set([
  "auroc",
  "auc",
  "f1",
  "tcga",
  "nsclc",
  "luad",
  "lusc",
  "abmil",
  "clam",
  "dsmil",
  "mil",
  "rnn",
  "cnn",
  "gat",
  "gcn",
  "vit",
  "swin",
  "llm",
  "pdf",
  "wsi",
  "wsip",
  "aucroc",
]);

const SMALL_WORDS = new Set(["of", "on", "for", "and", "the", "a", "an", "vs", "to", "in", "per", "by"]);

/** Turn a slug key into readable English, keeping common acronyms. */
export function titleFromFactKey(key: string): string {
  const trimmed = key.trim().replace(/^fact:/, "");
  const uniq = trimmed.match(/^(.*)-(\d+)$/);
  const core = uniq ? uniq[1]! : trimmed;
  const suffix = uniq ? ` (${uniq[2]})` : "";
  const raw = core.split("-").filter(Boolean);
  const words = raw.map((w, i) => {
    if (ACRONYMS.has(w)) return w.toUpperCase();
    if (/^[a-z]+\d+$/i.test(w)) return w.toUpperCase();
    if (i > 0 && SMALL_WORDS.has(w)) return w;
    return w.charAt(0).toUpperCase() + w.slice(1);
  });
  return `${words.join(" ")}${suffix}`;
}

function formatFactValue(value: number, unit?: string): string {
  const abs = Math.abs(value);
  let text: string;
  if (Number.isInteger(value)) text = String(value);
  else if (abs >= 100) text = value.toFixed(1);
  else if (abs >= 10) text = value.toFixed(2);
  else if (abs >= 1) text = value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  else text = value.toPrecision(3).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  return unit ? `${text} ${unit}` : text;
}

/**
 * Human-readable fact label for UI/graph. Prefers the authoring sentence
 * over the machine key (e.g. "AUROC of ABMIL on TCGA…" not "auroc-of-abmil-…").
 */
export function humanizeFactLabel(opts: {
  input?: string;
  key?: string;
  value?: number | null;
  unit?: string;
  maxLen?: number;
}): string {
  const maxLen = opts.maxLen ?? 56;
  const input = (opts.input || "").trim();
  let base = "";
  if (input) {
    const m = input.match(/^(AUROC|AUC|C-index|accuracy|F1)\s+of\s+(.+?)(?:\s+on\s+(.+))?$/i);
    if (m) {
      const metric = m[1]!;
      const model = m[2]!.trim().replace(/\s+/g, " ");
      let dataset = (m[3] || "").trim().replace(/\s+/g, " ");
      // Drop trailing parenthetical detail when space is tight.
      if (dataset.length > 28) dataset = dataset.replace(/\s*\([^)]*\)\s*$/, "").trim();
      base = dataset ? `${model} on ${dataset}` : `${metric} of ${model}`;
    } else {
      base = input.replace(/\s+/g, " ");
    }
  } else if (opts.key) {
    base = titleFromFactKey(opts.key);
  } else {
    base = "Fact";
  }
  if (opts.value != null && Number.isFinite(opts.value)) {
    const vs = formatFactValue(opts.value, opts.unit || undefined);
    const room = Math.max(12, maxLen - vs.length - 3);
    if (base.length > room) base = `${base.slice(0, Math.max(0, room - 1)).trimEnd()}…`;
    return `${base} · ${vs}`;
  }
  if (base.length > maxLen) return `${base.slice(0, Math.max(0, maxLen - 1)).trimEnd()}…`;
  return base;
}

/** Slugify free text into a candidate key (may still need uniquify). */
export function slugifyFactKey(input: string): string {
  const lowered = input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  let base = lowered.replace(/^[^a-z]+/, "");
  if (!base) base = "fact";
  if (base.length < 2) base = `${base}x`;
  if (!/^[a-z]/.test(base)) base = `f-${base}`;
  return base.slice(0, 64);
}

/**
 * Pick a unique key from `preferred` (or slug of `input`) given the set of
 * keys already taken library-wide.
 */
export function uniquifyFactKey(
  preferred: string | undefined,
  input: string,
  taken: ReadonlySet<string>,
): string {
  const seed = preferred && isValidFactKey(preferred) ? preferred : slugifyFactKey(input);
  if (!taken.has(seed)) return seed;
  for (let n = 2; n < 10_000; n += 1) {
    const suffix = `-${n}`;
    const maxBase = 64 - suffix.length;
    const candidate = `${seed.slice(0, maxBase)}${suffix}`;
    if (isValidFactKey(candidate) && !taken.has(candidate)) return candidate;
  }
  throw new Error("Could not allocate a unique fact key");
}
