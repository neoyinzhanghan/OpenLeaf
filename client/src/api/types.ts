export type LatexEngine = "pdflatex" | "xelatex";

export type AppConfig = {
  host: string;
  port: number;
  projectsRoot: string;
  libraryRoot: string;
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

export type PaperAuthor = {
  given: string;
  family: string;
};

export type PaperIntegrity = {
  existence: "verified" | "unresolved" | "mismatch";
  retraction: "clean" | "retracted" | "corrected";
  lastChecked: string | null;
  /** Present when existence !== verified — why it is not a checked journal article. */
  reason?: string | null;
};

export type PaperSource = "doi" | "arxiv" | "pdf-upload" | "bibtex-import" | "manual";

export type ReadingStatus = "unread" | "to-read" | "reading" | "read" | "archived";

export type LibrarySort = "added" | "title" | "year" | "rating" | "starred" | "status";

/** Canonical library paper — mirrors server/services/library record.json. */
export type PaperRecord = {
  citekey: string;
  doi: string | null;
  arxivId: string | null;
  url: string | null;
  title: string;
  authors: PaperAuthor[];
  venue: string;
  year: number | null;
  abstract: string;
  tags: string[];
  collections: string[];
  notes: string;
  attachment: string | null;
  source: PaperSource;
  starred: boolean;
  status: ReadingStatus;
  rating: number;
  integrity: PaperIntegrity;
  addedAt: string;
  updatedAt?: string;
};

export type LibraryCollections = {
  version: 1;
  collections: Record<string, { name: string; createdAt?: string; color?: string }>;
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

export type TrackChangesResult = CompileResult & {
  from: GitCommitInfo;
  to: GitCommitInfo;
  cached: boolean;
  expandedMacros: string[];
  scratchRelative: string;
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

export type TimelineNode = {
  id: string;
  branchId: string;
  parentId: string | null;
  /** Second parent of a merge leaf (source tip that was merged in). */
  mergeParentId?: string | null;
  gitHash: string;
  message: string;
  author: string;
  createdAt: string;
  legacy?: boolean;
};

export type TimelineBranch = {
  id: string;
  name: string;
  sacred: boolean;
  headNodeId: string | null;
  createdAt: string;
  gitRef: string;
  /** Soft-pruned tips are omitted from the timeline view. */
  prunedAt?: string | null;
};

export type TimelineView = {
  version: 1;
  activeBranchId: string;
  viewingNodeId: string | null;
  branches: TimelineBranch[];
  nodes: TimelineNode[];
  dirty: boolean;
  canEdit: boolean;
  activeBranch: TimelineBranch;
  headNode: TimelineNode | null;
  viewingNode: TimelineNode | null;
  /** Historical commit hash when viewing a non-tip leaf; null at tip. */
  viewingGitHash: string | null;
};

export type DiffHighlightBox = {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type DiffDeletedHunk = {
  afterLine: number;
  lines: string[];
};

export type FileChangeDiff = {
  file: string;
  status: "added" | "deleted" | "modified" | "renamed";
  fromFile?: string;
  addedLines: number[];
  deletedHunks: DiffDeletedHunk[];
  additions: number;
  deletions: number;
  entireFile?: boolean;
};

export type DiffHighlightsResult = {
  gitEnabled: boolean;
  since: GitCommitInfo | null;
  files: number;
  lines: number;
  additions: number;
  deletions: number;
  boxes: DiffHighlightBox[];
  changes: FileChangeDiff[];
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
