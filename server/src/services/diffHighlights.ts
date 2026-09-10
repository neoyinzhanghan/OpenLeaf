import { flushProjectRoom } from "./collab/room.js";
import {
  getProjectCommit,
  getRootProjectCommit,
  isGitEnabled,
  isHighlightableTexLine,
  isManuscriptTexPath,
  listWorkingTreeChanges,
  type FileChangeDiff,
  type GitCommitInfo,
} from "./projectGit.js";
import { ensureBranchRoot } from "./timeline.js";
import { boxesForFileLines, type SynctexBox } from "./synctex.js";

export type DiffHighlightsResult = {
  gitEnabled: boolean;
  since: GitCommitInfo | null;
  /** Files touched (create / modify / delete / rename). */
  files: number;
  /** @deprecated use additions — kept for older clients */
  lines: number;
  additions: number;
  deletions: number;
  boxes: SynctexBox[];
  /** Per-file editor decorations (Cursor-style show changes). */
  changes: FileChangeDiff[];
  branchId: string;
  /** When set, diff is commit-range `since..at` (checkpoint view). */
  at?: string | null;
  warning?: string;
};

/**
 * Changes since a git snapshot:
 * - live tip: working-tree vs `since` (flush first)
 * - checkpoint view (`at`): commit range `since..at` (matches editor content)
 * - `changes` for Monaco (+/− decorations / deleted view zones)
 * - `boxes` for PDF SyncTeX overlays (live tip only)
 */
export async function computeDiffHighlights(
  id: string,
  sinceRaw?: string,
  branchId = "main",
  atRaw?: string,
): Promise<DiffHighlightsResult> {
  if (!isGitEnabled()) {
    return {
      gitEnabled: false,
      since: null,
      files: 0,
      lines: 0,
      additions: 0,
      deletions: 0,
      boxes: [],
      changes: [],
      branchId,
      at: null,
      warning: "Git backups are disabled",
    };
  }

  const at =
    typeof atRaw === "string" && /^[0-9a-f]{7,40}$/i.test(atRaw.trim()) ? atRaw.trim() : undefined;

  // Only flush the live worktree when comparing against it.
  if (!at) {
    await flushProjectRoom(id, { commit: false, branchId });
  }
  const cwd = await ensureBranchRoot(id, branchId);

  const since =
    !sinceRaw || sinceRaw === "root"
      ? await getRootProjectCommit(id)
      : await getProjectCommit(id, sinceRaw);

  if (!since) {
    throw Object.assign(
      new Error(sinceRaw && sinceRaw !== "root" ? "Commit not found" : "No git snapshots yet"),
      { status: sinceRaw && sinceRaw !== "root" ? 404 : 400 },
    );
  }

  const tree = await listWorkingTreeChanges(id, since.hash, { cwd, until: at });
  const changes = tree.files;

  // PDF: SyncTeX maps onto the current build — only meaningful for the live tip.
  let boxes: SynctexBox[] = [];
  let pdfLineCount = 0;
  let warning: string | undefined;
  if (!at) {
    const fileLines = new Map<string, Set<number> | "all">();
    for (const entry of changes) {
      if (!isManuscriptTexPath(entry.file) || entry.status === "deleted") continue;
      if (entry.entireFile && entry.status === "added") {
        fileLines.set(entry.file, "all");
        pdfLineCount += Math.max(entry.additions, 1);
        continue;
      }
      if (entry.addedLines.length) {
        fileLines.set(entry.file, new Set(entry.addedLines));
        pdfLineCount += entry.addedLines.length;
      }
    }
    boxes = await boxesForFileLines(id, fileLines, cwd);
    warning =
      tree.additions + tree.deletions > 0 && boxes.length === 0 && pdfLineCount > 0
        ? "Compile the project so SyncTeX can place addition highlights on the PDF"
        : tree.additions + tree.deletions > 0 && boxes.length === 0 && pdfLineCount === 0
          ? "No manuscript .tex additions to map onto the PDF (editor still shows all +/− changes)"
          : undefined;
  } else if (tree.additions + tree.deletions > 0) {
    warning = "Checkpoint view — +/− in the editor; PDF overlays apply on the live tip";
  }

  void isHighlightableTexLine;

  return {
    gitEnabled: true,
    since,
    files: changes.length,
    lines: tree.additions,
    additions: tree.additions,
    deletions: tree.deletions,
    boxes,
    changes,
    branchId,
    at: at ?? null,
    warning,
  };
}
