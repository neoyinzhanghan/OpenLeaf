import { z } from "zod";

/** BibTeX-safe citekey: letters, digits, underscore, hyphen, colon. */
export const CitekeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z][A-Za-z0-9_.:-]*$/, "Invalid citekey");

export const AuthorSchema = z.object({
  given: z.string().default(""),
  family: z.string().min(1),
});

export const IntegritySchema = z.object({
  existence: z.enum(["verified", "unresolved", "mismatch"]).default("unresolved"),
  retraction: z.enum(["clean", "retracted", "corrected"]).default("clean"),
  lastChecked: z.string().nullable().default(null),
});

export const PaperSourceSchema = z.enum([
  "doi",
  "arxiv",
  "pdf-upload",
  "bibtex-import",
  "manual",
]);

/**
 * Canonical paper record — source of truth on disk as papers/<citekey>/record.json.
 * index.sqlite is derived and must never be treated as authoritative.
 */
export const PaperRecordSchema = z.object({
  citekey: CitekeySchema,
  doi: z.string().nullable().default(null),
  arxivId: z.string().nullable().default(null),
  /** Canonical public landing page (doi.org, arxiv.org, publisher, or Scholar). */
  url: z.string().nullable().default(null),
  title: z.string().min(1),
  authors: z.array(AuthorSchema).default([]),
  venue: z.string().default(""),
  year: z.number().int().nullable().default(null),
  abstract: z.string().default(""),
  tags: z.array(z.string()).default([]),
  collections: z.array(z.string()).default([]),
  notes: z.string().default(""),
  attachment: z.string().nullable().default(null),
  source: PaperSourceSchema.default("manual"),
  integrity: IntegritySchema.default({}),
  addedAt: z.string().min(1),
});

export type PaperRecord = z.infer<typeof PaperRecordSchema>;
export type PaperAuthor = z.infer<typeof AuthorSchema>;
export type PaperIntegrity = z.infer<typeof IntegritySchema>;
export type PaperSource = z.infer<typeof PaperSourceSchema>;

export const CollectionsFileSchema = z.object({
  version: z.literal(1).default(1),
  /** Named collection ids → display labels (and optional metadata later). */
  collections: z
    .record(
      z.string(),
      z.object({
        name: z.string().min(1),
        createdAt: z.string().optional(),
      }),
    )
    .default({}),
});

export type CollectionsFile = z.infer<typeof CollectionsFileSchema>;

export const CreatePaperInputSchema = z.object({
  citekey: CitekeySchema.optional(),
  doi: z.string().nullable().optional(),
  arxivId: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
  title: z.string().min(1),
  authors: z.array(AuthorSchema).optional(),
  venue: z.string().optional(),
  year: z.number().int().nullable().optional(),
  abstract: z.string().optional(),
  tags: z.array(z.string()).optional(),
  collections: z.array(z.string()).optional(),
  notes: z.string().optional(),
  attachment: z.string().nullable().optional(),
  source: PaperSourceSchema.optional(),
});

export type CreatePaperInput = z.infer<typeof CreatePaperInputSchema>;

export const PatchPaperInputSchema = CreatePaperInputSchema.partial()
  .omit({ citekey: true })
  .extend({
    citekey: CitekeySchema.optional(),
  });

export type PatchPaperInput = z.infer<typeof PatchPaperInputSchema>;

export type LibrarySearchOpts = {
  q?: string;
  tag?: string;
  collection?: string;
  limit?: number;
};
