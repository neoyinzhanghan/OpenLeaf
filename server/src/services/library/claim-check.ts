/**
 * Claim-support classification — LLM entailment behind a clean interface.
 * Verdicts are triage signals ("flagged for review"), never ground truth.
 * Swap this for scite.ai Smart Citations later without touching callers.
 */
import { createHash } from "node:crypto";

export type ClaimVerdict =
  | "supporting"
  | "contrasting"
  | "mentioning"
  | "unverifiable"
  | "not_checked";

export type ClaimCheckInput = {
  claimText: string;
  /** Prefer abstract; full text when abstract-level is inconclusive. */
  evidenceText: string;
  paperTitle?: string;
};

export type ClaimCheckResult = {
  verdict: ClaimVerdict;
  evidence: string;
  confidence: number;
  /** Always surface as triage — never certified fact. */
  flaggedForReview: true;
  method: "llm" | "heuristic" | "skipped";
};

export type ClaimChecker = {
  check(input: ClaimCheckInput): Promise<ClaimCheckResult>;
};

export function hashClaimContext(claimText: string, evidenceDigest: string): string {
  return createHash("sha256").update(`${claimText}\n---\n${evidenceDigest}`).digest("hex");
}

/** Keyword-overlap heuristic when no LLM is configured. */
export function createHeuristicClaimChecker(): ClaimChecker {
  return {
    async check(input) {
      const claim = input.claimText.toLowerCase();
      const evidence = input.evidenceText.toLowerCase();
      if (!claim.trim() || !evidence.trim()) {
        return {
          verdict: "unverifiable",
          evidence: "",
          confidence: 0.2,
          flaggedForReview: true,
          method: "heuristic",
        };
      }
      const tokens = claim
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((t) => t.length > 4);
      if (tokens.length === 0) {
        return {
          verdict: "mentioning",
          evidence: evidence.slice(0, 240),
          confidence: 0.3,
          flaggedForReview: true,
          method: "heuristic",
        };
      }
      const hits = tokens.filter((t) => evidence.includes(t));
      const ratio = hits.length / tokens.length;
      if (ratio >= 0.45) {
        const idx = evidence.indexOf(hits[0]!);
        return {
          verdict: "supporting",
          evidence: evidence.slice(Math.max(0, idx - 40), idx + 200).trim(),
          confidence: Math.min(0.75, 0.4 + ratio * 0.4),
          flaggedForReview: true,
          method: "heuristic",
        };
      }
      const contrastHints = ["however", "contrary", "not support", "fails to", "unlike"];
      if (contrastHints.some((h) => evidence.includes(h)) && ratio > 0.15) {
        return {
          verdict: "contrasting",
          evidence: evidence.slice(0, 240),
          confidence: 0.45,
          flaggedForReview: true,
          method: "heuristic",
        };
      }
      return {
        verdict: "unverifiable",
        evidence: evidence.slice(0, 160),
        confidence: 0.35,
        flaggedForReview: true,
        method: "heuristic",
      };
    },
  };
}

/**
 * OpenAI-compatible chat completions (OPENLEAF_CLAIM_CHECK_URL +
 * OPENLEAF_CLAIM_CHECK_API_KEY). Falls back to heuristic on failure.
 */
export function createLlmClaimChecker(opts?: {
  url?: string;
  apiKey?: string;
  model?: string;
  fetchImpl?: typeof fetch;
}): ClaimChecker {
  const url =
    opts?.url ??
    process.env.OPENLEAF_CLAIM_CHECK_URL ??
    (process.env.OPENLEAF_OPENAI_API_KEY ? "https://api.openai.com/v1/chat/completions" : "");
  const apiKey =
    opts?.apiKey ?? process.env.OPENLEAF_CLAIM_CHECK_API_KEY ?? process.env.OPENLEAF_OPENAI_API_KEY ?? "";
  const model = opts?.model ?? process.env.OPENLEAF_CLAIM_CHECK_MODEL ?? "gpt-4o-mini";
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const fallback = createHeuristicClaimChecker();

  if (!url || !apiKey) return fallback;

  return {
    async check(input) {
      try {
        const res = await fetchImpl(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            temperature: 0,
            response_format: { type: "json_object" },
            messages: [
              {
                role: "system",
                content:
                  'Classify whether the cited paper supports the claim. Reply JSON: {"verdict":"supporting|contrasting|mentioning|unverifiable","evidence":"short excerpt","confidence":0-1}. This is a triage signal only.',
              },
              {
                role: "user",
                content: `Paper: ${input.paperTitle ?? "(untitled)"}\n\nClaim: ${input.claimText}\n\nEvidence:\n${input.evidenceText.slice(0, 6000)}`,
              },
            ],
          }),
        });
        if (!res.ok) return fallback.check(input);
        const body = (await res.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        const raw = body.choices?.[0]?.message?.content ?? "";
        const parsed = JSON.parse(raw) as {
          verdict?: string;
          evidence?: string;
          confidence?: number;
        };
        const verdict = (
          ["supporting", "contrasting", "mentioning", "unverifiable"] as ClaimVerdict[]
        ).includes(parsed.verdict as ClaimVerdict)
          ? (parsed.verdict as ClaimVerdict)
          : "unverifiable";
        return {
          verdict,
          evidence: String(parsed.evidence ?? "").slice(0, 500),
          confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0.5)),
          flaggedForReview: true,
          method: "llm",
        };
      } catch {
        return fallback.check(input);
      }
    },
  };
}

let checker: ClaimChecker | null = null;

export function getClaimChecker(): ClaimChecker {
  if (!checker) checker = createLlmClaimChecker();
  return checker;
}

export function setClaimCheckerForTests(c: ClaimChecker | null): void {
  checker = c;
}
