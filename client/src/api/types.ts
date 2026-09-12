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

export type AgentContextTurn = {
  schemaVersion: number;
  kind: "agent-context";
  usage: string;
  shareStatus: "auto";
  conversationId: string;
  generationId: string;
  writtenAt: string;
  capsulePath: string;
  baseCommit: string | null;
  diffDigest: string | null;
  objective: string | null;
  outcome: string | null;
  decisions: Array<{ statement: string; rationale?: string }>;
  changedFiles: string[];
  verification: Array<{ check: string; status: "passed" | "failed" | "error" | "unknown" }>;
  assumptions: string[];
  openQuestions: string[];
  nextSteps: string[];
};

export type AgentContextSession = {
  conversationId: string;
  startedAt: string | null;
  turnCount: number;
  turns: AgentContextTurn[];
};

export type AgentContextView = {
  commit: {
    nodeId: string | null;
    gitHash: string;
    shortHash: string;
    message: string;
    author: string;
    createdAt: string;
  };
  sessions: AgentContextSession[];
  skipped: number;
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
