/**
 * Fact key generation and validation. Pure — no I/O. Spec §4.1.
 */

export const FACT_KEY_RE = /^[a-z][a-z0-9-]{1,63}$/;

export function isValidFactKey(key: string): boolean {
  return FACT_KEY_RE.test(key);
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
