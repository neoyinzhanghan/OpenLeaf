/**
 * Per-paper PDF annotations (highlights / pinned notes) stored as
 * papers/<citekey>/annotations.json — sibling of record.json.
 */
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { getPaper } from "./index.js";
import { annotationsPath, ensureLibraryRoot, paperDir } from "./paths.js";

export const PaperAnnotationSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["note", "highlight"]).default("highlight"),
  body: z.string().default(""),
  quote: z.string().optional().default(""),
  color: z.string().optional().default("#facc15"),
  page: z.number().int().positive().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  w: z.number().optional(),
  h: z.number().optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export type PaperAnnotation = z.infer<typeof PaperAnnotationSchema>;

const AnnotationsFileSchema = z.object({
  version: z.literal(1).default(1),
  annotations: z.array(PaperAnnotationSchema).default([]),
});

export type AnnotationsFile = z.infer<typeof AnnotationsFileSchema>;

export const CreateAnnotationInputSchema = z.object({
  kind: z.enum(["note", "highlight"]).optional().default("highlight"),
  body: z.string().default(""),
  quote: z.string().optional(),
  color: z.string().optional(),
  page: z.number().int().positive().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  w: z.number().optional(),
  h: z.number().optional(),
});

export type CreateAnnotationInput = z.infer<typeof CreateAnnotationInputSchema>;

export const PatchAnnotationInputSchema = CreateAnnotationInputSchema.partial();
export type PatchAnnotationInput = z.infer<typeof PatchAnnotationInputSchema>;

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

function newId(): string {
  return `ann_${randomBytes(8).toString("hex")}`;
}

async function readFile(citekey: string): Promise<AnnotationsFile> {
  const file = annotationsPath(citekey);
  if (!fs.existsSync(file)) return { version: 1, annotations: [] };
  try {
    const raw = JSON.parse(await fsPromises.readFile(file, "utf8")) as unknown;
    const parsed = AnnotationsFileSchema.safeParse(raw);
    return parsed.success ? parsed.data : { version: 1, annotations: [] };
  } catch {
    return { version: 1, annotations: [] };
  }
}

async function writeFile(citekey: string, data: AnnotationsFile): Promise<void> {
  ensureLibraryRoot();
  await fsPromises.mkdir(paperDir(citekey), { recursive: true });
  await fsPromises.writeFile(
    annotationsPath(citekey),
    `${JSON.stringify(data, null, 2)}\n`,
    "utf8",
  );
}

export async function listAnnotations(citekey: string): Promise<PaperAnnotation[]> {
  await getPaper(citekey);
  const file = await readFile(citekey);
  return [...file.annotations].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function addAnnotation(
  citekey: string,
  input: CreateAnnotationInput,
): Promise<PaperAnnotation> {
  await getPaper(citekey);
  const parsed = CreateAnnotationInputSchema.parse(input);
  if (!parsed.body.trim() && !parsed.quote?.trim()) {
    throw httpError(400, "Annotation needs a body or quote");
  }
  const now = new Date().toISOString();
  const annotation = PaperAnnotationSchema.parse({
    id: newId(),
    kind: parsed.kind ?? "highlight",
    body: parsed.body.trim(),
    quote: parsed.quote?.trim() ?? "",
    color: parsed.color ?? "#facc15",
    page: parsed.page,
    x: parsed.x,
    y: parsed.y,
    w: parsed.w,
    h: parsed.h,
    createdAt: now,
    updatedAt: now,
  });
  const file = await readFile(citekey);
  file.annotations.push(annotation);
  await writeFile(citekey, file);
  return annotation;
}

export async function updateAnnotation(
  citekey: string,
  id: string,
  patch: PatchAnnotationInput,
): Promise<PaperAnnotation> {
  await getPaper(citekey);
  const parsed = PatchAnnotationInputSchema.parse(patch);
  const file = await readFile(citekey);
  const idx = file.annotations.findIndex((a) => a.id === id);
  if (idx < 0) throw httpError(404, `Annotation not found: ${id}`);
  const prev = file.annotations[idx]!;
  const next = PaperAnnotationSchema.parse({
    ...prev,
    ...parsed,
    body: parsed.body !== undefined ? parsed.body.trim() : prev.body,
    quote: parsed.quote !== undefined ? parsed.quote.trim() : prev.quote,
    updatedAt: new Date().toISOString(),
  });
  file.annotations[idx] = next;
  await writeFile(citekey, file);
  return next;
}

export async function deleteAnnotation(citekey: string, id: string): Promise<void> {
  await getPaper(citekey);
  const file = await readFile(citekey);
  const next = file.annotations.filter((a) => a.id !== id);
  if (next.length === file.annotations.length) throw httpError(404, `Annotation not found: ${id}`);
  await writeFile(citekey, { version: 1, annotations: next });
}
