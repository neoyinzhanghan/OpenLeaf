import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { projectDir } from "./projectFs.js";

export const CommentAnchorSchema = z.object({
  file: z.string().min(1),
  line: z.number().int().positive(),
  column: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
  endColumn: z.number().int().positive().optional(),
  quote: z.string().max(500).optional(),
  pdfPage: z.number().int().positive().optional(),
  pdfX: z.number().optional(),
  pdfY: z.number().optional(),
});

export const CommentReplySchema = z.object({
  id: z.string().min(1),
  authorId: z.string().min(1),
  authorName: z.string().min(1),
  authorColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  body: z.string().min(1).max(8000),
  createdAt: z.string().min(1),
});

export const CommentThreadSchema = z.object({
  id: z.string().min(1),
  anchor: CommentAnchorSchema,
  authorId: z.string().min(1),
  authorName: z.string().min(1),
  authorColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  body: z.string().min(1).max(8000),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  resolved: z.boolean(),
  replies: z.array(CommentReplySchema).default([]),
});

export type CommentAnchor = z.infer<typeof CommentAnchorSchema>;
export type CommentReply = z.infer<typeof CommentReplySchema>;
export type CommentThread = z.infer<typeof CommentThreadSchema>;

const FileSchema = z.object({
  version: z.number().int().positive().default(1),
  threads: z.array(CommentThreadSchema).default([]),
});

export function commentsFilePath(projectId: string): string {
  return path.join(projectDir(projectId), "comments.json");
}

function newId(): string {
  return randomBytes(8).toString("hex");
}

export async function listComments(projectId: string): Promise<CommentThread[]> {
  const file = commentsFilePath(projectId);
  if (!fsSync.existsSync(file)) return [];
  try {
    const raw = JSON.parse(await fs.readFile(file, "utf8")) as unknown;
    const parsed = FileSchema.safeParse(raw);
    if (!parsed.success) return [];
    return parsed.data.threads;
  } catch {
    return [];
  }
}

async function saveComments(projectId: string, threads: CommentThread[]): Promise<void> {
  const file = commentsFilePath(projectId);
  const payload = { version: 1 as const, threads };
  await fs.writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

export type AuthorInfo = {
  id: string;
  name: string;
  color: string;
};

export async function createComment(
  projectId: string,
  opts: {
    author: AuthorInfo;
    body: string;
    anchor: CommentAnchor;
  },
): Promise<CommentThread> {
  const now = new Date().toISOString();
  const thread: CommentThread = {
    id: newId(),
    anchor: CommentAnchorSchema.parse(opts.anchor),
    authorId: opts.author.id,
    authorName: opts.author.name,
    authorColor: opts.author.color,
    body: opts.body.trim(),
    createdAt: now,
    updatedAt: now,
    resolved: false,
    replies: [],
  };
  if (!thread.body) {
    throw Object.assign(new Error("Comment body is required"), { status: 400 });
  }
  const threads = await listComments(projectId);
  threads.push(thread);
  await saveComments(projectId, threads);
  return thread;
}

export async function addCommentReply(
  projectId: string,
  commentId: string,
  opts: { author: AuthorInfo; body: string },
): Promise<CommentThread> {
  const threads = await listComments(projectId);
  const idx = threads.findIndex((t) => t.id === commentId);
  if (idx < 0) throw Object.assign(new Error("Comment not found"), { status: 404 });
  const body = opts.body.trim();
  if (!body) throw Object.assign(new Error("Reply body is required"), { status: 400 });
  const reply: CommentReply = {
    id: newId(),
    authorId: opts.author.id,
    authorName: opts.author.name,
    authorColor: opts.author.color,
    body,
    createdAt: new Date().toISOString(),
  };
  const thread = { ...threads[idx]! };
  thread.replies = [...thread.replies, reply];
  thread.updatedAt = reply.createdAt;
  threads[idx] = thread;
  await saveComments(projectId, threads);
  return thread;
}

export async function patchComment(
  projectId: string,
  commentId: string,
  patch: { resolved?: boolean; body?: string },
): Promise<CommentThread> {
  const threads = await listComments(projectId);
  const idx = threads.findIndex((t) => t.id === commentId);
  if (idx < 0) throw Object.assign(new Error("Comment not found"), { status: 404 });
  const thread = { ...threads[idx]! };
  if (typeof patch.resolved === "boolean") thread.resolved = patch.resolved;
  if (typeof patch.body === "string") {
    const body = patch.body.trim();
    if (!body) throw Object.assign(new Error("Comment body is required"), { status: 400 });
    thread.body = body;
  }
  thread.updatedAt = new Date().toISOString();
  threads[idx] = thread;
  await saveComments(projectId, threads);
  return thread;
}

export async function deleteComment(projectId: string, commentId: string): Promise<void> {
  const threads = await listComments(projectId);
  const next = threads.filter((t) => t.id !== commentId);
  if (next.length === threads.length) {
    throw Object.assign(new Error("Comment not found"), { status: 404 });
  }
  await saveComments(projectId, next);
}
