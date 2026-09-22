/**
 * Per-project citations.json — source-anchored claim instances (mirrors comments.json).
 */
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { projectDir, readFile } from "../projectFs.js";
import { getPaper } from "./index.js";
import { checkPaperIntegrity } from "./integrity.js";
import {
  getClaimChecker,
  hashClaimContext,
  type ClaimVerdict,
} from "./claim-check.js";
import { resolveOpenAccessPdf } from "./integrity.js";

export const CitationInstanceSchema = z.object({
  citekey: z.string().min(1),
  file: z.string().min(1),
  line: z.number().int().positive(),
  claimText: z.string().default(""),
  claimHash: z.string().optional(),
  verdict: z
    .enum(["supporting", "contrasting", "mentioning", "unverifiable", "not_checked"])
    .default("not_checked"),
  evidence: z.string().default(""),
  confidence: z.number().min(0).max(1).default(0),
  flaggedForReview: z.boolean().default(true),
  checkedAt: z.string().nullable().default(null),
});

export type CitationInstance = z.infer<typeof CitationInstanceSchema>;

const FileSchema = z.object({
  version: z.literal(1).default(1),
  instances: z.array(CitationInstanceSchema).default([]),
});

export function citationsFilePath(projectId: string): string {
  return path.join(projectDir(projectId), "citations.json");
}

export async function listCitationInstances(projectId: string): Promise<CitationInstance[]> {
  const file = citationsFilePath(projectId);
  if (!fs.existsSync(file)) return [];
  try {
    const raw = JSON.parse(await fsPromises.readFile(file, "utf8")) as unknown;
    const parsed = FileSchema.safeParse(raw);
    return parsed.success ? parsed.data.instances : [];
  } catch {
    return [];
  }
}

async function saveCitationInstances(
  projectId: string,
  instances: CitationInstance[],
): Promise<void> {
  const file = citationsFilePath(projectId);
  await fsPromises.writeFile(
    file,
    `${JSON.stringify({ version: 1, instances }, null, 2)}\n`,
    "utf8",
  );
}

const CITE_RE =
  /\\(?:cite|citep|nocite|citet|citepauthor|citeyear|citeyearpar|parencite|autocite|textcite|footcite|fullcite|citeauthor)\*?\{([^}]+)\}/g;

/** Scan .tex files for \\cite{…} and surrounding sentence as claimText. */
export async function scanProjectCitations(
  projectId: string,
  filePaths: string[],
): Promise<CitationInstance[]> {
  const existing = await listCitationInstances(projectId);
  const byKey = new Map(existing.map((i) => [`${i.file}:${i.line}:${i.citekey}`, i]));
  const next: CitationInstance[] = [];

  for (const file of filePaths) {
    if (!file.endsWith(".tex") || file.startsWith("misc/")) continue;
    let content: string;
    try {
      const payload = await readFile(projectId, file, { forceText: true });
      if (payload.encoding !== "utf8") continue;
      content = payload.content;
    } catch {
      continue;
    }
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      CITE_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = CITE_RE.exec(line))) {
        const keys = m[1]!.split(",").map((k) => k.trim()).filter(Boolean);
        const claimText = extractSentence(lines, i);
        for (const citekey of keys) {
          const key = `${file}:${i + 1}:${citekey}`;
          const prev = byKey.get(key);
          const claimHash = hashClaimContext(claimText, citekey);
          if (prev && prev.claimHash === claimHash && prev.verdict !== "not_checked") {
            next.push(prev);
          } else {
            next.push(
              CitationInstanceSchema.parse({
                citekey,
                file,
                line: i + 1,
                claimText,
                claimHash,
                verdict: "not_checked",
                evidence: "",
                confidence: 0,
                flaggedForReview: true,
                checkedAt: null,
              }),
            );
          }
        }
      }
    }
  }
  await saveCitationInstances(projectId, next);
  return next;
}

function extractSentence(lines: string[], lineIdx: number): string {
  const window = lines.slice(Math.max(0, lineIdx - 1), lineIdx + 2).join(" ");
  const cleaned = window.replace(/\s+/g, " ").trim();
  // Rough sentence around the cite
  const parts = cleaned.split(/(?<=[.!?])\s+/);
  return (parts.find((p) => /\\cite/.test(p)) ?? cleaned).slice(0, 500);
}

async function evidenceForPaper(citekey: string): Promise<{ text: string; level: "abstract" | "fulltext" | "none" }> {
  try {
    const paper = await getPaper(citekey);
    if (paper.abstract?.trim()) return { text: paper.abstract, level: "abstract" };
    // Optional fulltext.txt beside the record
    const { paperDir } = await import("./paths.js");
    const ft = path.join(paperDir(citekey), "fulltext.txt");
    if (fs.existsSync(ft)) {
      return { text: await fsPromises.readFile(ft, "utf8"), level: "fulltext" };
    }
    return { text: `${paper.title}\n${paper.venue}\n${paper.year ?? ""}`, level: "none" };
  } catch {
    return { text: "", level: "none" };
  }
}

export async function verifyClaimInstance(
  projectId: string,
  file: string,
  line: number,
  opts?: { citekey?: string; force?: boolean },
): Promise<CitationInstance> {
  let instances = await listCitationInstances(projectId);
  let target = instances.find(
    (i) => i.file === file && i.line === line && (!opts?.citekey || i.citekey === opts.citekey),
  );
  if (!target) {
    // Rescan this file only
    await scanProjectCitations(projectId, [file]);
    instances = await listCitationInstances(projectId);
    target = instances.find(
      (i) => i.file === file && i.line === line && (!opts?.citekey || i.citekey === opts.citekey),
    );
  }
  if (!target) {
    throw Object.assign(new Error("No citation at that location"), { status: 404 });
  }

  const evidenceDigest = (await evidenceForPaper(target.citekey)).text.slice(0, 200);
  const claimHash = hashClaimContext(target.claimText, evidenceDigest);
  if (
    !opts?.force &&
    target.claimHash === claimHash &&
    target.verdict !== "not_checked" &&
    target.checkedAt
  ) {
    return target;
  }

  let { text: evidenceText, level } = await evidenceForPaper(target.citekey);
  const checker = getClaimChecker();
  let result = await checker.check({
    claimText: target.claimText,
    evidenceText,
    paperTitle: target.citekey,
  });

  // Full-text only when abstract-level is inconclusive.
  if (
    (result.verdict === "unverifiable" || result.confidence < 0.45) &&
    level === "abstract"
  ) {
    try {
      const paper = await getPaper(target.citekey);
      if (paper.doi) {
        const oa = await resolveOpenAccessPdf(paper.doi);
        if (oa) {
          // Record OA URL in notes for the user; do not fetch binary PDF content here.
          evidenceText = `${evidenceText}\n\n[OA PDF available: ${oa}]`;
        }
      }
    } catch {
      /* ignore */
    }
    result = await checker.check({
      claimText: target.claimText,
      evidenceText,
      paperTitle: target.citekey,
    });
  }

  const updated: CitationInstance = {
    ...target,
    claimHash,
    verdict: result.verdict,
    evidence: result.evidence,
    confidence: result.confidence,
    flaggedForReview: true,
    checkedAt: new Date().toISOString(),
  };

  const idx = instances.findIndex(
    (i) => i.file === updated.file && i.line === updated.line && i.citekey === updated.citekey,
  );
  if (idx >= 0) instances[idx] = updated;
  else instances.push(updated);
  await saveCitationInstances(projectId, instances);
  return updated;
}

export type ProjectIntegrityReport = {
  integrity: Awaited<ReturnType<typeof checkPaperIntegrity>>[];
  claims: CitationInstance[];
};

export async function checkProjectCitationIntegrity(
  projectId: string,
  opts?: { texFiles?: string[]; force?: boolean },
): Promise<ProjectIntegrityReport> {
  const files = opts?.texFiles ?? [];
  const instances = files.length
    ? await scanProjectCitations(projectId, files)
    : await listCitationInstances(projectId);

  const citekeys = [...new Set(instances.map((i) => i.citekey))];
  const integrity = [];
  for (const key of citekeys) {
    try {
      integrity.push(await checkPaperIntegrity(key, { force: opts?.force }));
    } catch {
      /* paper may not be in library */
    }
  }

  const claims: CitationInstance[] = [];
  for (const inst of instances) {
    try {
      claims.push(
        await verifyClaimInstance(projectId, inst.file, inst.line, {
          citekey: inst.citekey,
          force: opts?.force,
        }),
      );
    } catch {
      claims.push(inst);
    }
  }
  return { integrity, claims };
}

export type { ClaimVerdict };
