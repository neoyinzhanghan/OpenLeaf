/**
 * Expression evaluator for calculation bodies. Never uses eval. Spec §5.4.
 */

export type EvalValueSource =
  | { kind: "fact"; key: string; value: number | null; rejected?: boolean }
  | { kind: "kn"; id: string; name?: string; value: number | null; rejected?: boolean; flagged?: boolean }
  | { kind: "out"; name: string; value: number };

export type EvalContext = {
  resolve: (ref: { kind: string; key?: string; id?: string; name?: string }) => EvalValueSource | null;
};

export type EvalError = { message: string; line?: number };

export type EvalResult = {
  value: number | null;
  errors: EvalError[];
  flagged: boolean;
};

type Tok =
  | { t: "num"; v: number }
  | { t: "op"; v: string }
  | { t: "lp" }
  | { t: "rp" }
  | { t: "ref"; kind: "fact" | "kn" | "out"; key?: string; id?: string; name?: string };

function tokenize(expr: string, errors: EvalError[]): Tok[] {
  // Protect refs before brace/command rewrites turn `{` into `(`.
  const placeholders: Tok[] = [];
  let s = expr.replace(/\\kn\[([^\]]*)\]\{([^}]*)\}/g, (_m, name: string, id: string) => {
    const idx = placeholders.length;
    placeholders.push({
      t: "ref",
      kind: "kn",
      name: name.trim() || undefined,
      id: id.trim(),
    });
    return ` ⟦${idx}⟧ `;
  });
  s = s.replace(/\\fact\{([^}]*)\}/g, (_m, key: string) => {
    const idx = placeholders.length;
    placeholders.push({ t: "ref", kind: "fact", key: key.trim() });
    return ` ⟦${idx}⟧ `;
  });
  s = s.replace(/\\kn\{([^}]*)\}/g, (_m, id: string) => {
    const idx = placeholders.length;
    placeholders.push({ t: "ref", kind: "kn", id: id.trim() });
    return ` ⟦${idx}⟧ `;
  });
  s = s.replace(/\\out\{([^}]*)\}/g, (_m, name: string) => {
    const idx = placeholders.length;
    placeholders.push({ t: "ref", kind: "out", name: name.trim() });
    return ` ⟦${idx}⟧ `;
  });

  s = s
    .replace(/\\left\(/g, "(")
    .replace(/\\right\)/g, ")")
    .replace(/\\times/g, "*")
    .replace(/\\cdot/g, "*")
    .replace(/\\div/g, "/")
    .replace(/\^/g, "^");
  // \frac{a}{b} → (a)/(b)
  s = s.replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, "(($1)/($2))");
  // braces as grouping
  s = s.replace(/\{/g, "(").replace(/\}/g, ")");

  const toks: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i]!;
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === "(") {
      toks.push({ t: "lp" });
      i += 1;
      continue;
    }
    if (ch === ")") {
      toks.push({ t: "rp" });
      i += 1;
      continue;
    }
    if ("+-*/^".includes(ch)) {
      toks.push({ t: "op", v: ch });
      i += 1;
      continue;
    }
    if (s.startsWith("⟦", i)) {
      const end = s.indexOf("⟧", i);
      if (end < 0) {
        errors.push({ message: "Bad reference placeholder" });
        break;
      }
      const idx = Number(s.slice(i + 1, end));
      const ref = placeholders[idx];
      if (!ref) {
        errors.push({ message: "Bad reference placeholder" });
        break;
      }
      toks.push(ref);
      i = end + 1;
      continue;
    }
    if (/[0-9.]/.test(ch) || (ch === "-" && /[0-9]/.test(s[i + 1] ?? ""))) {
      let j = i;
      if (s[j] === "+" || s[j] === "-") j += 1;
      while (j < s.length && /[0-9.,]/.test(s[j]!)) j += 1;
      if (j < s.length && (s[j] === "e" || s[j] === "E")) {
        j += 1;
        if (j < s.length && (s[j] === "+" || s[j] === "-")) j += 1;
        while (j < s.length && /[0-9]/.test(s[j]!)) j += 1;
      }
      const raw = s.slice(i, j).replace(/,/g, "");
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        errors.push({ message: `Bad number “${s.slice(i, j)}”` });
        break;
      }
      toks.push({ t: "num", v: n });
      i = j;
      continue;
    }
    errors.push({ message: `Unexpected “${ch}” in expression` });
    break;
  }
  return toks;
}

function lbp(op: string): number {
  if (op === "+" || op === "-") return 10;
  if (op === "*" || op === "/") return 20;
  if (op === "^") return 30;
  return 0;
}

function evaluateTokens(toks: Tok[], ctx: EvalContext, errors: EvalError[]): { value: number | null; flagged: boolean } {
  let flagged = false;
  let pos = 0;

  const peek = () => toks[pos];
  const take = () => toks[pos++];

  function parsePrimary(): number | null {
    const tok = take();
    if (!tok) {
      errors.push({ message: "Unexpected end of expression" });
      return null;
    }
    if (tok.t === "num") return tok.v;
    if (tok.t === "op" && tok.v === "-") {
      const v = parsePrimary();
      return v == null ? null : -v;
    }
    if (tok.t === "lp") {
      const v = parseExpr(0);
      if (peek()?.t !== "rp") errors.push({ message: "Missing )" });
      else take();
      return v;
    }
    if (tok.t === "ref") {
      const resolved = ctx.resolve(tok);
      if (!resolved) {
        errors.push({
          message:
            tok.kind === "fact"
              ? `Unknown fact “${tok.key}”`
              : tok.kind === "kn"
                ? `Unknown knowledge “${tok.id}”`
                : `Unknown output “${tok.name}”`,
        });
        return null;
      }
      if (resolved.kind === "fact" && resolved.value == null) {
        errors.push({ message: `Fact “${tok.key}” has no numeric value` });
        return null;
      }
      if ("rejected" in resolved && resolved.rejected) flagged = true;
      if ("flagged" in resolved && resolved.flagged) flagged = true;
      return resolved.value;
    }
    errors.push({ message: "Expected number or reference" });
    return null;
  }

  function parseExpr(minBp: number): number | null {
    let left = parsePrimary();
    if (left == null) return null;
    for (;;) {
      const tok = peek();
      if (!tok || tok.t !== "op") break;
      const bp = lbp(tok.v);
      if (bp < minBp) break;
      take();
      const right = parseExpr(tok.v === "^" ? bp : bp + 1);
      if (right == null) return null;
      if (tok.v === "+") left += right;
      else if (tok.v === "-") left -= right;
      else if (tok.v === "*") left *= right;
      else if (tok.v === "/") left /= right;
      else if (tok.v === "^") left = left ** right;
    }
    return left;
  }

  const value = parseExpr(0);
  if (pos < toks.length) errors.push({ message: "Trailing tokens in expression" });
  return { value, flagged };
}

/** Evaluate a calculation body string. */
export function evaluateExpression(body: string, ctx: EvalContext): EvalResult {
  const errors: EvalError[] = [];
  // Drop \left \right already handled; strip leftover commands that aren't refs
  const cleaned = body.replace(/\\[a-zA-Z]+(?![\[{])/g, (cmd) => {
    if (["\\times", "\\cdot", "\\div", "\\left", "\\right", "\\frac"].some((c) => cmd.startsWith(c))) {
      return cmd;
    }
    // unknown command — leave for tokenizer to error, or strip
    return cmd;
  });
  const toks = tokenize(cleaned, errors);
  if (errors.length && !toks.length) return { value: null, errors, flagged: false };
  const { value, flagged } = evaluateTokens(toks, ctx, errors);
  return {
    value: value != null && Number.isFinite(value) ? value : null,
    errors,
    flagged,
  };
}

export function formatKnowledgeNumber(
  value: number,
  opts?: { digits?: number; unit?: string },
): string {
  const digits = opts?.digits ?? 3;
  let v = value;
  let suffix = "";
  const unit = opts?.unit ?? "";
  if (unit === "%" || unit === "percent") {
    v = value * 100;
    suffix = "%";
  } else if (unit === "USD" || unit === "$") {
    suffix = "";
    const body = formatSig(v, digits);
    return `$${body}`;
  } else if (unit) {
    suffix = ` ${unit}`;
  }
  return `${formatSig(v, digits)}${suffix}`;
}

function formatSig(n: number, digits: number): string {
  if (!Number.isFinite(n)) return "??";
  const abs = Math.abs(n);
  let s: string;
  if (abs !== 0 && (abs >= 10 ** digits || abs < 10 ** -(digits - 1))) {
    s = n.toExponential(Math.max(0, digits - 1));
  } else {
    s = n.toPrecision(digits);
  }
  // thousands separators for large ints
  if (/^-?\d+(\.0+)?$/.test(s) && Math.abs(n) >= 1000) {
    return Math.round(n).toLocaleString("en-US");
  }
  return s.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

export type KnowledgeItemValues = {
  knowledgeId: string;
  outputs: Record<string, number>;
  primary: number | null;
  errors: EvalError[];
  flagged: boolean;
};

/**
 * Evaluate knowledge items in topological order. Cycles get errors on every member.
 */
export function evaluateKnowledgeGraph(
  items: Array<{
    knowledgeId: string;
    steps: Array<{ id: string; kind: string; name?: string; body: string; sets: Array<{ name: string; value: number }> }>;
    resultName: string | null;
    dependsOn: string[]; // knowledge ids
  }>,
  facts: Map<string, { value: number | null; rejected?: boolean }>,
): Map<string, KnowledgeItemValues> {
  const byId = new Map(items.map((i) => [i.knowledgeId, i]));
  const result = new Map<string, KnowledgeItemValues>();
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cycleNodes = new Set<string>();

  const visit = (id: string, stack: string[]) => {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      const start = stack.indexOf(id);
      for (const c of stack.slice(start >= 0 ? start : 0)) cycleNodes.add(c);
      cycleNodes.add(id);
      return;
    }
    visiting.add(id);
    const item = byId.get(id);
    if (item) {
      for (const dep of item.dependsOn) visit(dep, [...stack, id]);
    }
    visiting.delete(id);
    visited.add(id);
  };

  for (const item of items) visit(item.knowledgeId, []);

  const order = items.map((i) => i.knowledgeId).filter((id) => !cycleNodes.has(id));
  // Kahn-ish: recompute order from deps among non-cycle
  const remaining = new Set(order);
  const sorted: string[] = [];
  while (remaining.size) {
    let progressed = false;
    for (const id of [...remaining]) {
      const item = byId.get(id)!;
      if (item.dependsOn.every((d) => !remaining.has(d) || cycleNodes.has(d))) {
        sorted.push(id);
        remaining.delete(id);
        progressed = true;
      }
    }
    if (!progressed) {
      for (const id of remaining) cycleNodes.add(id);
      break;
    }
  }

  for (const id of cycleNodes) {
    const item = byId.get(id)!;
    result.set(id, {
      knowledgeId: id,
      outputs: {},
      primary: null,
      errors: [{ message: `Circular reference involving ${[...cycleNodes].join(" → ")}` }],
      flagged: false,
    });
    void item;
  }

  for (const id of sorted) {
    const item = byId.get(id)!;
    const outputs: Record<string, number> = {};
    const errors: EvalError[] = [];
    let flagged = false;

    for (const step of item.steps) {
      for (const set of step.sets) outputs[set.name] = set.value;
      if (step.kind !== "calculation") continue;
      const ctx: EvalContext = {
        resolve: (ref) => {
          if (ref.kind === "fact" && ref.key) {
            const f = facts.get(ref.key);
            if (!f) return null;
            return { kind: "fact", key: ref.key, value: f.value, rejected: f.rejected };
          }
          if (ref.kind === "out" && ref.name) {
            if (!(ref.name in outputs)) return null;
            return { kind: "out", name: ref.name, value: outputs[ref.name]! };
          }
          if (ref.kind === "kn" && ref.id) {
            const other = result.get(ref.id);
            if (!other) return null;
            const name = ref.name;
            const value =
              name && name in other.outputs
                ? other.outputs[name]!
                : other.primary;
            return {
              kind: "kn",
              id: ref.id,
              name,
              value: value ?? null,
              flagged: other.flagged,
            };
          }
          return null;
        },
      };
      const ev = evaluateExpression(step.body, ctx);
      errors.push(...ev.errors);
      if (ev.flagged) flagged = true;
      if (ev.value != null && step.name) outputs[step.name] = ev.value;
    }

    const primary =
      item.resultName && item.resultName in outputs
        ? outputs[item.resultName]!
        : Object.values(outputs).at(-1) ?? null;

    result.set(id, { knowledgeId: id, outputs, primary, errors, flagged });
  }

  return result;
}
