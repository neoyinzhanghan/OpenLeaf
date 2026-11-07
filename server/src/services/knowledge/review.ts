/**
 * review.json — host-UI-only step reviews. Spec §4.4, §5.5.
 */
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { getProjectsRootAbs } from "../../config.js";
import { parseKnowledge } from "./parse.js";
import { normalizeStepText, computeStepStatus, type StepReviewRecord } from "./status.js";
import { listAllFacts } from "../library/facts.js";
import { readProjectConfig } from "../projectFs.js";
import { invalidateKnowledgeGraph } from "./graph.js";

const ReviewFileSchema = z.object({
  version: z.literal(1).default(1),
  steps: z
    .record(
      z.string(),
      z.object({
        hash: z.string(),
        verdict: z.enum(["reviewed", "rejected"]),
        by: z.string().default(""),
        at: z.string(),
        /** Last reviewed body text — for inbox word diffs. */
        text: z.string().optional(),
        inputs: z
          .record(
            z.string(),
            z.object({
              value: z.number().nullable().optional(),
              status: z.string().optional(),
              hash: z.string().optional(),
              updatedAt: z.string().optional(),
              result: z.number().nullable().optional(),
            }),
          )
          .optional(),
      }),
    )
    .default({}),
});

export type ReviewFile = z.infer<typeof ReviewFileSchema>;

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

function reviewPath(projectId: string): string {
  return path.join(getProjectsRootAbs(), projectId, "review.json");
}

export function hashStepBody(body: string): string {
  return createHash("sha256").update(normalizeStepText(body)).digest("hex");
}

export async function readReviewFile(projectId: string): Promise<ReviewFile> {
  const file = reviewPath(projectId);
  if (!fs.existsSync(file)) return { version: 1, steps: {} };
  try {
    const raw = JSON.parse(await fsPromises.readFile(file, "utf8"));
    const parsed = ReviewFileSchema.safeParse(raw);
    return parsed.success ? parsed.data : { version: 1, steps: {} };
  } catch {
    return { version: 1, steps: {} };
  }
}

async function writeReviewFile(projectId: string, data: ReviewFile): Promise<void> {
  const file = reviewPath(projectId);
  await fsPromises.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  invalidateKnowledgeGraph();
}

async function loadMainTex(projectId: string): Promise<{ text: string; mainFile: string }> {
  const cfg = await readProjectConfig(projectId);
  const mainFile = cfg.mainFile || "main.tex";
  const text = await fsPromises.readFile(path.join(getProjectsRootAbs(), projectId, mainFile), "utf8");
  return { text, mainFile };
}

export async function listStepStatuses(projectId: string): Promise<
  Array<{
    id: string;
    status: string;
    why: string[];
    body: string;
    hash: string;
    line?: number;
    reviewedText?: string;
  }>
> {
  const { text, mainFile } = await loadMainTex(projectId);
  const parsed = parseKnowledge({ [mainFile]: text });
  const review = await readReviewFile(projectId);
  const facts = await listAllFacts();
  const factByKey = new Map(facts.filter((f) => f.key).map((f) => [f.key!, f]));

  return parsed.steps.map((step) => {
    const h = hashStepBody(step.body);
    const rec = review.steps[step.id] as (StepReviewRecord & { text?: string }) | undefined;
    const inputStatuses = step.refs.map((r) => {
      if (r.kind === "fact") {
        const f = factByKey.get(r.key);
        const snap = rec?.inputs?.[`fact:${r.key}`];
        return {
          id: `fact:${r.key}`,
          status: (f?.status ?? "unreviewed") as import("./status.js").Status,
          valueChanged: snap != null && f != null && snap.value !== f.value,
        };
      }
      return { id: `${r.kind}:${"id" in r ? r.id : "name" in r ? r.name : "?"}`, status: "reviewed" as const };
    });
    const { status, why } = computeStepStatus({
      id: step.id,
      textHash: h,
      review: rec ?? null,
      inputStatuses,
    });
    return {
      id: step.id,
      status,
      why,
      body: step.body,
      hash: h,
      line: step.line,
      reviewedText: rec?.text,
    };
  });
}

export async function reviewStep(
  projectId: string,
  stepId: string,
  verdict: "reviewed" | "rejected" | "clear",
  by = "",
): Promise<ReviewFile> {
  const { text, mainFile } = await loadMainTex(projectId);
  const parsed = parseKnowledge({ [mainFile]: text });
  const step = parsed.steps.find((s) => s.id === stepId);
  if (!step) throw httpError(404, `Unknown step ${stepId}`);

  const file = await readReviewFile(projectId);
  if (verdict === "clear") {
    delete file.steps[stepId];
    await writeReviewFile(projectId, file);
    return file;
  }

  const facts = await listAllFacts();
  const factByKey = new Map(facts.filter((f) => f.key).map((f) => [f.key!, f]));
  const inputs: NonNullable<ReviewFile["steps"][string]["inputs"]> = {};
  for (const r of step.refs) {
    if (r.kind === "fact") {
      const f = factByKey.get(r.key);
      inputs[`fact:${r.key}`] = {
        value: f?.value ?? null,
        status: f?.status,
        updatedAt: f?.updatedAt,
      };
    } else if (r.kind === "kn" || r.kind === "knref") {
      inputs[`kn:${r.id}`] = { hash: "" };
    }
  }

  file.steps[stepId] = {
    hash: hashStepBody(step.body),
    verdict,
    by,
    at: new Date().toISOString(),
    text: step.body,
    inputs,
  };
  await writeReviewFile(projectId, file);
  return file;
}
