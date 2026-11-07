/**
 * Status computation with reasons. Spec §5.5.
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

export function computeStepStatus(step: StepInfo): { status: Status; why: string[] } {
  const why: string[] = [];
  if (!step.review || step.review.hash !== step.textHash) {
    return { status: "needs-review", why: step.review ? ["step text changed since review"] : ["not reviewed yet"] };
  }
  if (step.review.verdict === "rejected") {
    return { status: "rejected", why: ["rejected by reviewer"] };
  }
  for (const input of step.inputStatuses) {
    if (input.status === "rejected") {
      why.push(`${input.id} rejected`);
    } else if (input.status === "flagged") {
      why.push(`${input.id} flagged`);
    } else if (input.valueChanged) {
      why.push(`${input.id} value changed`);
    }
  }
  if (why.length) return { status: "flagged", why };
  return { status: "reviewed", why: [] };
}

export function computeItemStatus(opts: {
  steps: Array<{ status: Status }>;
  hasErrors: boolean;
}): Status {
  if (opts.steps.some((s) => s.status === "rejected")) return "rejected";
  if (opts.steps.some((s) => s.status === "flagged")) return "flagged";
  if (opts.hasErrors || opts.steps.some((s) => s.status === "needs-review") || !opts.steps.length) {
    return "needs-review";
  }
  return "reviewed";
}

export function computeFactStatus(
  stored: "confirmed" | "unreviewed" | "rejected" | "not_found",
): Status {
  return stored;
}

export function computeProjectStatus(upstream: Status[]): Status {
  if (upstream.some((s) => s === "rejected" || s === "flagged")) return "flagged";
  return "up-to-date";
}
