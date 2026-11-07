/**
 * Knowledge LaTeX parser — tokenizer for the openleaf-knowledge command set.
 * Pure, heavily unit-tested. Spec §5.3.
 */

export type KnowledgeRef =
  | { kind: "fact"; key: string }
  | { kind: "kn"; id: string; name?: string }
  | { kind: "knref"; id: string }
  | { kind: "out"; name: string };

export type KnowledgeSet = { name: string; value: number; line: number };

export type KnowledgeStep = {
  id: string;
  kind: "calculation" | "assumption" | "judgment" | "conclusion";
  name?: string;
  line: number;
  endLine: number;
  body: string;
  refs: KnowledgeRef[];
  sets: KnowledgeSet[];
  opts?: Record<string, string>;
};

export type KnowledgeParseError = {
  message: string;
  line: number;
  file?: string;
};

export type KnowledgeParseResult = {
  title: string;
  resultName: string | null;
  steps: KnowledgeStep[];
  conclusion?: string;
  refs: KnowledgeRef[];
  errors: KnowledgeParseError[];
};

type FileMap = Record<string, string>;

function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text[i] === "\n") line += 1;
  }
  return line;
}

/** Strip TeX comments (% not preceded by \), preserve newlines for line numbers. */
export function stripComments(src: string): string {
  let out = "";
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i]!;
    if (ch === "%" && (i === 0 || src[i - 1] !== "\\")) {
      while (i < src.length && src[i] !== "\n") i += 1;
      if (i < src.length) out += "\n";
      continue;
    }
    out += ch;
  }
  return out;
}

function readBalanced(src: string, start: number, open: string, close: string): { body: string; end: number } | null {
  if (src[start] !== open) return null;
  let depth = 0;
  for (let i = start; i < src.length; i += 1) {
    const ch = src[i]!;
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return { body: src.slice(start + 1, i), end: i + 1 };
    }
  }
  return null;
}

function parseOpts(raw: string | undefined): Record<string, string> {
  if (!raw?.trim()) return {};
  const trimmed = raw.trim();
  // `\begin{assumption}[growth]` — bare token is an id, not a key=value opt.
  if (!trimmed.includes("=")) return { id: trimmed.split(",")[0]!.trim() };
  const out: Record<string, string> = {};
  for (const part of trimmed.split(",")) {
    const [k, ...rest] = part.split("=");
    if (!k?.trim()) continue;
    out[k.trim()] = rest.join("=").trim();
  }
  return out;
}

function collectRefs(body: string): KnowledgeRef[] {
  const refs: KnowledgeRef[] = [];
  const patterns: Array<{ re: RegExp; map: (m: RegExpExecArray) => KnowledgeRef | null }> = [
    {
      re: /\\fact\{([a-z][a-z0-9-]{1,63})\}/g,
      map: (m) => ({ kind: "fact", key: m[1]! }),
    },
    {
      re: /\\kn\[([^\]]*)\]\{([a-z][a-z0-9-]{1,63})\}/g,
      map: (m) => ({ kind: "kn", id: m[2]!, name: m[1]!.trim() || undefined }),
    },
    {
      re: /\\kn\{([a-z][a-z0-9-]{1,63})\}/g,
      map: (m) => ({ kind: "kn", id: m[1]! }),
    },
    {
      re: /\\knref\{([a-z][a-z0-9-]{1,63})\}/g,
      map: (m) => ({ kind: "knref", id: m[1]! }),
    },
    {
      re: /\\out\{([a-zA-Z][a-zA-Z0-9_-]*)\}/g,
      map: (m) => ({ kind: "out", name: m[1]! }),
    },
  ];
  for (const { re, map } of patterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body))) {
      const ref = map(m);
      if (ref) refs.push(ref);
    }
  }
  return refs;
}

function collectSets(body: string, baseLine: number): KnowledgeSet[] {
  const sets: KnowledgeSet[] = [];
  const re = /\\set\{([^}]+)\}\{([^}]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const name = m[1]!.trim();
    const raw = m[2]!.trim().replace(/,/g, "");
    const value = Number(raw);
    if (!name || !Number.isFinite(value)) continue;
    const line = baseLine + body.slice(0, m.index).split("\n").length - 1;
    sets.push({ name, value, line });
  }
  return sets;
}

function expandInputs(files: FileMap, mainFile: string, errors: KnowledgeParseError[]): string {
  const seen = new Set<string>();
  const walk = (file: string): string => {
    const norm = file.replace(/\\/g, "/");
    if (seen.has(norm)) {
      errors.push({ message: `Circular \\input{${file}}`, line: 1, file });
      return "";
    }
    seen.add(norm);
    const raw = files[norm] ?? files[`${norm}.tex`] ?? "";
    if (!raw && !(norm in files) && !(`${norm}.tex` in files)) {
      errors.push({ message: `Missing \\input{${file}}`, line: 1, file: mainFile });
      return "";
    }
    const text = stripComments(raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n"));
    return text.replace(/\\(?:input|include)\{([^}]+)\}/g, (_whole, name: string) => walk(name.trim()));
  };
  return walk(mainFile);
}

/**
 * Parse a knowledge item (or any project using the package) from a file map.
 */
export function parseKnowledge(files: FileMap, mainFile = "main.tex"): KnowledgeParseResult {
  const errors: KnowledgeParseError[] = [];
  const src = expandInputs(files, mainFile, errors);
  const steps: KnowledgeStep[] = [];
  const allRefs: KnowledgeRef[] = [];
  let title = "";
  let resultName: string | null = null;
  let conclusion: string | undefined;
  let assumptionN = 0;
  let judgmentN = 0;

  // knowledge environment
  const knEnv = /\\begin\{knowledge\}(?:\[([^\]]*)\])?\{/.exec(src);
  if (knEnv) {
    const opts = parseOpts(knEnv[1]);
    if (opts.result) resultName = opts.result;
    const brace = readBalanced(src, knEnv.index + knEnv[0].length - 1, "{", "}");
    if (brace) title = brace.body.trim();
  }

  const envRe =
    /\\begin\{(calculation|assumption|judgment)\}(?:\[([^\]]*)\])?(?:\{([^}]*)\})?/g;
  let m: RegExpExecArray | null;
  while ((m = envRe.exec(src))) {
    const kind = m[1] as "calculation" | "assumption" | "judgment";
    const optRaw = m[2];
    const nameArg = m[3];
    const beginEnd = m.index + m[0].length;
    const endToken = `\\end{${kind}}`;
    const endIdx = src.indexOf(endToken, beginEnd);
    if (endIdx < 0) {
      errors.push({ message: `Unclosed ${kind} environment`, line: lineAt(src, m.index) });
      continue;
    }
    const body = src.slice(beginEnd, endIdx).trim();
    const line = lineAt(src, m.index);
    const endLine = lineAt(src, endIdx);
    const opts = parseOpts(optRaw);
    let id = "";
    let name: string | undefined;
    if (kind === "calculation") {
      name = (nameArg ?? opts.id ?? "calc").trim() || "calc";
      id = `calculation:${name}`;
    } else if (kind === "assumption") {
      assumptionN += 1;
      const custom = opts.id || nameArg;
      id = custom ? `assumption:${custom}` : `assumption:${assumptionN}`;
      name = custom;
    } else {
      judgmentN += 1;
      const custom = opts.id || nameArg;
      id = custom ? `judgment:${custom}` : `judgment:${judgmentN}`;
      name = custom;
    }
    const refs = collectRefs(body);
    const sets = collectSets(body, line);
    allRefs.push(...refs);
    steps.push({ id, kind, name, line, endLine, body, refs, sets, opts });
    envRe.lastIndex = endIdx + endToken.length;
  }

  const conc = /\\conclusion\{/.exec(src);
  if (conc) {
    const brace = readBalanced(src, conc.index + "\\conclusion".length, "{", "}");
    if (brace) {
      conclusion = brace.body.trim();
      const refs = collectRefs(conclusion);
      allRefs.push(...refs);
      steps.push({
        id: "conclusion",
        kind: "conclusion",
        line: lineAt(src, conc.index),
        endLine: lineAt(src, brace.end),
        body: conclusion,
        refs,
        sets: [],
      });
    }
  }

  // Top-level refs outside steps
  const topRefs = collectRefs(src);
  for (const r of topRefs) allRefs.push(r);

  if (!resultName) {
    const calcs = steps.filter((s) => s.kind === "calculation");
    resultName = calcs.length ? calcs[calcs.length - 1]!.name ?? null : null;
  }

  return {
    title,
    resultName,
    steps,
    conclusion,
    refs: allRefs,
    errors,
  };
}
