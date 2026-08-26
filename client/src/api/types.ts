export type LatexEngine = "pdflatex" | "xelatex";

export type AppConfig = {
  host: string;
  port: number;
  projectsRoot: string;
  latex: {
    engine: LatexEngine;
    autoCompile: boolean;
    timeoutMs: number;
    outputDir: string;
  };
  client: {
    devPort: number;
  };
  identities?: Array<{
    id: string;
    name: string;
    color: string;
  }>;
  collab?: {
    flushMs: number;
    persistYjs: boolean;
  };
  git?: {
    enabled: boolean;
  };
};

export type ProjectMeta = {
  id: string;
  name: string;
  mainFile: string;
  engine: LatexEngine;
  path: string;
};

export type TreeNode = {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: TreeNode[];
};

export type FilePayload = {
  path: string;
  encoding: "utf8" | "base64";
  content: string;
  contentType: string;
  size: number;
  text: boolean;
  /** True when the body was skipped because the file exceeds the inline limit. */
  contentOmitted?: boolean;
};

export type CompileResult = {
  ok: boolean;
  engine: LatexEngine;
  usedLatexmk: boolean;
  log: string;
  pdfRelative: string | null;
  durationMs: number;
};

export type SynctexHit = {
  input: string;
  line: number;
  column: number;
};

export type SynctexForwardHit = {
  page: number;
  x: number;
  y: number;
  h: number;
  v: number;
  width: number;
  height: number;
};

export type GitCommitResult = {
  committed: boolean;
  hash: string | null;
  message: string;
  skipped?: "disabled" | "clean" | "error";
  error?: string;
};

export type GitCommitInfo = {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  email: string;
  date: string;
};

export type DiffHighlightBox = {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type DiffHighlightsResult = {
  gitEnabled: boolean;
  since: GitCommitInfo | null;
  files: number;
  lines: number;
  boxes: DiffHighlightBox[];
  warning?: string;
};

export type CommentAnchor = {
  file: string;
  line: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
  quote?: string;
  pdfPage?: number;
  pdfX?: number;
  pdfY?: number;
};

export type CommentReply = {
  id: string;
  authorId: string;
  authorName: string;
  authorColor: string;
  body: string;
  createdAt: string;
};

export type CommentThread = {
  id: string;
  anchor: CommentAnchor;
  authorId: string;
  authorName: string;
  authorColor: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  resolved: boolean;
  replies: CommentReply[];
};
