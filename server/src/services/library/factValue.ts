/**
 * Parse a numeric value + unit from a fact answer string.
 * Pure — no I/O. Spec §4.1.
 */

export type ParsedFactValue = {
  value: number | null;
  unit: string;
};

/** First number in the string: optional sign, digits, optional decimal / scientific. */
const NUMBER_RE = /[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:[eE][-+]?\d+)?/;

function stripThousands(raw: string): string {
  return raw.replace(/,/g, "");
}

/**
 * Parse `answer` for a value-type fact.
 * - `x%` → value x/100, unit "%"
 * - `0.880 ± 0.057` → first number 0.88 (uncertainty ignored)
 * - thousands separators stripped
 * - no number → null
 */
export function parseFactValue(answer: string, existingUnit = ""): ParsedFactValue {
  const text = answer.trim();
  if (!text) return { value: null, unit: existingUnit };

  const match = text.match(NUMBER_RE);
  if (!match || match.index == null) return { value: null, unit: existingUnit };

  const raw = match[0]!;
  const num = Number(stripThousands(raw));
  if (!Number.isFinite(num)) return { value: null, unit: existingUnit };

  const after = text.slice(match.index + raw.length).trimStart();
  if (after.startsWith("%") || /^percent\b/i.test(after)) {
    return { value: num / 100, unit: "%" };
  }
  // "88%" with no space already consumed "%" via after; also handle glued "88%"
  if (raw.endsWith("%")) {
    // unreachable with NUMBER_RE, kept for clarity
  }
  // Check if the matched token was immediately followed inside original as n%
  const glued = text.slice(match.index, match.index + raw.length + 1);
  if (glued.endsWith("%")) {
    return { value: num / 100, unit: "%" };
  }

  return { value: num, unit: existingUnit };
}

/** Format a stored value for display when answer is empty. */
export function formatFactValue(value: number | null, unit: string): string {
  if (value == null || !Number.isFinite(value)) return "";
  if (unit === "%") {
    const pct = value * 100;
    return `${trimNum(pct)}%`;
  }
  if (unit === "USD" || unit === "$") return `$${trimNum(value)}`;
  const body = trimNum(value);
  return unit ? `${body} ${unit}` : body;
}

function trimNum(n: number): string {
  if (Number.isInteger(n)) return String(n);
  const s = n.toPrecision(12).replace(/\.?0+$/, "");
  return s;
}
