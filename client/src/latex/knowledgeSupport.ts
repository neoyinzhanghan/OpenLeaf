/**
 * Pure helpers for knowledge editor decorations / cursor context.
 */

export type KnowledgeCursorTarget =
  | { kind: "fact"; key: string; line: number }
  | { kind: "kn"; id: string; line: number }
  | { kind: "step"; stepId: string; line: number }
  | null;

const FACT_RE = /\\fact\{([a-z][a-z0-9-]{0,63})\}/g;
const KN_RE = /\\kn(?:ref)?(?:\[[^\]]*\])?\{([a-z][a-z0-9-]{0,63})\}/g;
const STEP_BEGIN_RE =
  /\\begin\{(calculation|assumption|judgment)\}(?:\[[^\]]*\])?(?:\{([^}]*)\})?/;

export function knowledgeCursorTarget(
  lineText: string,
  column: number,
  lineNumber: number,
  nearbyLines: string[],
): KnowledgeCursorTarget {
  for (const re of [FACT_RE, KN_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(lineText))) {
      const start = m.index + m[0].indexOf("{") + 2; // 1-based col of first key char
      const end = start + m[1]!.length;
      if (column >= start && column <= end) {
        return re === FACT_RE
          ? { kind: "fact", key: m[1]!, line: lineNumber }
          : { kind: "kn", id: m[1]!, line: lineNumber };
      }
    }
  }

  // Walk upward for an open step environment
  for (let i = nearbyLines.length - 1; i >= 0; i -= 1) {
    const line = nearbyLines[i]!;
    if (/\\end\{(calculation|assumption|judgment)\}/.test(line)) break;
    const m = STEP_BEGIN_RE.exec(line);
    if (m) {
      const kind = m[1]!;
      const name = (m[2] || "").trim() || "anon";
      return { kind: "step", stepId: `${kind}:${name}`, line: lineNumber - (nearbyLines.length - 1 - i) };
    }
  }
  return null;
}

export function wordDiff(oldText: string, newText: string): Array<{ type: "same" | "del" | "add"; text: string }> {
  const a = oldText.split(/\s+/).filter(Boolean);
  const b = newText.split(/\s+/).filter(Boolean);
  // LCS DP
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: Array<{ type: "same" | "del" | "add"; text: string }> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: "same", text: a[i]! });
      i += 1;
      j += 1;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ type: "del", text: a[i]! });
      i += 1;
    } else {
      out.push({ type: "add", text: b[j]! });
      j += 1;
    }
  }
  while (i < n) {
    out.push({ type: "del", text: a[i]! });
    i += 1;
  }
  while (j < m) {
    out.push({ type: "add", text: b[j]! });
    j += 1;
  }
  return out;
}

export function extractOutNames(tex: string): string[] {
  const names = new Set<string>();
  for (const m of tex.matchAll(/\\begin\{calculation\}(?:\[[^\]]*\])?\{([^}]+)\}/g)) {
    names.add(m[1]!.trim());
  }
  for (const m of tex.matchAll(/\\set\{([^}]+)\}\{/g)) {
    names.add(m[1]!.trim());
  }
  return [...names].sort();
}
