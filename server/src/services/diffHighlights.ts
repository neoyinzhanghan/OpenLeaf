import { flushProjectRoom } from "./collab/room.js";
import {
  getProjectCommit,
  getRootProjectCommit,
  isGitEnabled,
  listAddedManuscriptLines,
  type GitCommitInfo,
} from "./projectGit.js";
import { boxesForFileLines, type SynctexBox } from "./synctex.js";

export type DiffHighlightsResult = {
  gitEnabled: boolean;
  since: GitCommitInfo | null;
  files: number;
  lines: number;
  boxes: SynctexBox[];
  warning?: string;
};

/**
 * Overlay boxes for manuscript .tex lines added since a git snapshot.
 * Flushes live collab to disk first (no commit) so the diff matches the editor.
 */
export async function computeDiffHighlights(
  id: string,
  sinceRaw?: string,
): Promise<DiffHighlightsResult> {
  if (!isGitEnabled()) {
    return {
      gitEnabled: false,
      since: null,
      files: 0,
      lines: 0,
      boxes: [],
      warning: "Git backups are disabled",
    };
  }

  await flushProjectRoom(id, { commit: false });

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

  const added = await listAddedManuscriptLines(id, since.hash);
  const fileLines = new Map<string, Set<number> | "all">();
  let lineCount = 0;
  for (const entry of added) {
    fileLines.set(entry.file, entry.entireFile ? "all" : new Set(entry.lines));
    lineCount += entry.entireFile ? Math.max(entry.lines.length, 1) : entry.lines.length;
  }

  const boxes = await boxesForFileLines(id, fileLines);
  const warning =
    lineCount > 0 && boxes.length === 0
      ? "Compile the project so SyncTeX can place highlights on the PDF"
      : undefined;

  return {
    gitEnabled: true,
    since,
    files: added.length,
    lines: lineCount,
    boxes,
    warning,
  };
}
