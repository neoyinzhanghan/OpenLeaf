/**
 * Status computation with reasons. Spec §5.5 + overnight truth rules:
 * upstream problems are always carried in `why`, and a paper is only
 * up-to-date when everything it cites is checked and clean.
 */

export type Status =
  | "needs-review"
  | "rejected"
  | "flagged"
  | "reviewed"
  | "confirmed"
  | "unreviewed"
  | "not_found"
  | "up-to-date";

export type StepReviewRecord = {
  hash: string;
  verdict: "reviewed" | "rejected";
  inputs?: Record<string, { value?: number | null; status?: string; hash?: string; updatedAt?: string }>;
};

export type StepInfo = {
  id: string;
  textHash: string;
  review?: StepReviewRecord | null;
  inputStatuses: Array<{ id: string; status: Status; valueChanged?: boolean }>;
};

export function normalizeStepText(body: string): string {
  return body
    .replace(/(^|[^\\])%.*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** Plain-English reasons for bad / unchecked upstream inputs. */
export function collectUpstreamWhy(
  inputStatuses: Array<{ id: string; status: Status; valueChanged?: boolean }>,
): string[] {
  const why: string[] = [];
  for (const input of inputStatuses) {
    if (input.status === "rejected") {
      why.push(`${input.id} rejected`);
    } else if (input.status === "flagged") {
      why.push(`${input.id} flagged`);
    } else if (input.status === "needs-review" || input.status === "unreviewed") {
      why.push(`${input.id} unchecked`);
    } else if (input.status === "not_found") {
      why.push(`${input.id} not found`);
    } else if (input.valueChanged) {
      why.push(`${input.id} value changed`);
    }
  }
  return why;
}

export function computeStepStatus(step: StepInfo): { status: Status; why: string[] } {
  const upstreamWhy = collectUpstreamWhy(step.inputStatuses);

  if (!step.review || step.review.hash !== step.textHash) {
    const base = step.review ? ["step text changed since review"] : ["not reviewed yet"];
    return { status: "needs-review", why: [...base, ...upstreamWhy] };
  }
  if (step.review.verdict === "rejected") {
    return { status: "rejected", why: ["rejected by reviewer", ...upstreamWhy] };
  }
  if (upstreamWhy.length) return { status: "flagged", why: upstreamWhy };
  return { status: "reviewed", why: [] };
}

export function computeItemStatus(opts: {
  steps: Array<{ status: Status; why?: string[] }>;
  hasErrors: boolean;
}): { status: Status; why: string[] } {
  const why = [...new Set(opts.steps.flatMap((s) => s.why ?? []))];
  if (opts.steps.some((s) => s.status === "rejected")) {
    return { status: "rejected", why: why.length ? why : ["a step was rejected"] };
  }
  if (opts.steps.some((s) => s.status === "flagged")) {
    return { status: "flagged", why: why.length ? why : ["a step is flagged"] };
  }
  if (opts.hasErrors || opts.steps.some((s) => s.status === "needs-review") || !opts.steps.length) {
    if (opts.hasErrors && !why.some((w) => /error/i.test(w))) why.push("has parse or evaluation errors");
    if (!opts.steps.length && !why.length) why.push("no steps yet");
    if (!why.length) why.push("steps need review");
    return { status: "needs-review", why };
  }
  return { status: "reviewed", why: [] };
}

export function computeFactStatus(
  stored: "confirmed" | "unreviewed" | "rejected" | "not_found",
): Status {
  return stored;
}

/** True when a cited node is fully checked and clean. */
export function isCleanUpstream(status: Status): boolean {
  return status === "confirmed" || status === "reviewed" || status === "up-to-date";
}

/**
 * A paper is only up-to-date when every cited fact/knowledge item is checked
 * and clean. Anything rejected, flagged, or still unchecked flags the paper.
 */
export function computeProjectStatus(upstream: Status[]): { status: Status; why: string[] } {
  const why: string[] = [];
  let hasHard = false;
  let hasSoft = false;
  for (const s of upstream) {
    if (s === "rejected") {
      hasHard = true;
      why.push("depends on a rejected fact or knowledge item");
    } else if (s === "flagged") {
      hasHard = true;
      why.push("depends on flagged upstream");
    } else if (s === "needs-review" || s === "unreviewed" || s === "not_found") {
      hasSoft = true;
      why.push("depends on unchecked upstream");
    }
  }
  const unique = [...new Set(why)];
  if (hasHard || hasSoft) return { status: "flagged", why: unique };
  return { status: "up-to-date", why: [] };
}
