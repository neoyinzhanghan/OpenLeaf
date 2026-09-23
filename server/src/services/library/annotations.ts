/**
 * Per-paper PDF annotations stored as papers/<citekey>/annotations.json.
 * Kinds: highlight / underline / area (rects), pin (point), note (free or page-linked).
 */
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { getPaper } from "./index.js";
import { annotationsPath, ensureLibraryRoot, paperDir } from "./paths.js";

export const AnnotationKindSchema = z.enum([
  "highlight",
  "underline",
  "area",
  "pin",
  "note",
]);
export type AnnotationKind = z.infer<typeof AnnotationKindSchema>;

export const AnnotationRectSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number().positive(),
  h: z.number().positive(),
});
export type AnnotationRect = z.infer<typeof AnnotationRectSchema>;

export const ANNOTATION_COLORS = [
  "#facc15", // yellow
  "#4ade80", // green
  "#60a5fa", // blue
  "#f472b6", // pink
  "#fb923c", // orange
  "#a78bfa", // purple
  "#94a3b8", // slate
] as const;

export const PaperAnnotationSchema = z.object({
  id: z.string().min(1),
  kind: AnnotationKindSchema.default("highlight"),
  body: z.string().default(""),
  quote: z.string().optional().default(""),
  color: z.string().optional().default("#facc15"),
  page: z.number().int().positive().optional(),
  /** Primary point / top-left of area (PDF points, y down). */
  x: z.number().optional(),
  y: z.number().optional(),
  w: z.number().optional(),
  h: z.number().optional(),
  /** Multi-rect text/area highlights (optional; primary bbox still used for jump). */
  rects: z.array(AnnotationRectSchema).optional().default([]),
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
  kind: AnnotationKindSchema.optional().default("highlight"),
  body: z.string().default(""),
  quote: z.string().optional(),
  color: z.string().optional(),
  page: z.number().int().positive().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  w: z.number().optional(),
  h: z.number().optional(),
  rects: z.array(AnnotationRectSchema).optional(),
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

function normalizeGeometry(input: CreateAnnotationInput | PatchAnnotationInput): {
  page?: number;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  rects: AnnotationRect[];
} {
  const rects = input.rects ?? [];
  let { page, x, y, w, h } = input;
  if (rects.length && (x == null || y == null)) {
    const xs = rects.map((r) => r.x);
    const ys = rects.map((r) => r.y);
    const rights = rects.map((r) => r.x + r.w);
    const bottoms = rects.map((r) => r.y + r.h);
    x = Math.min(...xs);
    y = Math.min(...ys);
    w = Math.max(...rights) - x;
    h = Math.max(...bottoms) - y;
  }
  return {
    page,
    x,
    y,
    w,
    h,
    rects: [...rects],
  };
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
  const kind = parsed.kind ?? "highlight";
  const body = parsed.body.trim();
  const quote = parsed.quote?.trim() ?? "";
  const needsPage = kind === "pin" || kind === "highlight" || kind === "underline" || kind === "area";
  if (needsPage && (parsed.page == null || parsed.page < 1)) {
    throw httpError(400, "Page-anchored annotations need a page number");
  }
  if (kind === "pin" && !body) {
    throw httpError(400, "Pin notes need a body");
  }
  if (kind === "note" && !body && !quote) {
    throw httpError(400, "Notes need a body");
  }
  if (
    (kind === "highlight" || kind === "underline" || kind === "area") &&
    !body &&
    !quote &&
    parsed.x == null &&
    !(parsed.rects && parsed.rects.length)
  ) {
    throw httpError(400, "Highlights need geometry (or a body/quote)");
  }

  const geo = normalizeGeometry(parsed);
  const now = new Date().toISOString();
  const annotation = PaperAnnotationSchema.parse({
    id: newId(),
    kind,
    body,
    quote,
    color: parsed.color ?? "#facc15",
    page: geo.page ?? parsed.page,
    x: geo.x,
    y: geo.y,
    w: geo.w,
    h: geo.h,
    rects: geo.rects,
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
  const geo = normalizeGeometry({
    page: parsed.page ?? prev.page,
    x: parsed.x ?? prev.x,
    y: parsed.y ?? prev.y,
    w: parsed.w ?? prev.w,
    h: parsed.h ?? prev.h,
    rects: parsed.rects ?? prev.rects,
  });
  const next = PaperAnnotationSchema.parse({
    ...prev,
    kind: parsed.kind ?? prev.kind,
    body: parsed.body !== undefined ? parsed.body.trim() : prev.body,
    quote: parsed.quote !== undefined ? parsed.quote.trim() : prev.quote,
    color: parsed.color ?? prev.color,
    page: parsed.page !== undefined ? parsed.page : prev.page,
    x: parsed.x !== undefined || parsed.rects ? geo.x : prev.x,
    y: parsed.y !== undefined || parsed.rects ? geo.y : prev.y,
    w: parsed.w !== undefined || parsed.rects ? geo.w : prev.w,
    h: parsed.h !== undefined || parsed.rects ? geo.h : prev.h,
    rects: parsed.rects !== undefined ? geo.rects : prev.rects,
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
