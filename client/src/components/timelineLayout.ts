import type { TimelineBranch, TimelineNode, TimelineView } from "../api/types";

export type TimelineLayoutNode = {
  node: TimelineNode;
  branch: TimelineBranch;
  x: number;
  y: number;
  isHead: boolean;
  isSacred: boolean;
  /** AI sandbox fork (`ai/…`). */
  isAi: boolean;
  lane: number;
  tickAbove: boolean;
  labelAbove: boolean;
  /** Extra outward offset steps so nearby labels/ticks don't collide. */
  labelTier: number;
  tickTier: number;
  /** Short stem even when time is hidden — keeps the cadence readable. */
  showTickStem: boolean;
  showTickTime: boolean;
  showLabel: boolean;
  labelMaxChars: number;
};

export type TimelineLayoutEdge = {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  sacred: boolean;
  fork: boolean;
  ai: boolean;
  /** Second-parent merge arrow (source tip → merge leaf). */
  merge: boolean;
};

export type TimelineLayoutResult = {
  nodes: TimelineLayoutNode[];
  edges: TimelineLayoutEdge[];
  width: number;
  height: number;
  originY: number;
  padLeft: number;
};

type Scale = {
  laneGap: number;
  padLeft: number;
  padRight: number;
  /** Same-lane consecutive leaves (minutes apart). */
  minGap: number;
  maxGap: number;
  baseGap: number;
  /** Parent → first leaf on a new lane. */
  forkGap: number;
  /** Same timestamp, same lane. */
  sameGap: number;
  padTop: number;
};

function scaleFor(compact?: boolean): Scale {
  if (compact) {
    return {
      laneGap: 44,
      padLeft: 24,
      padRight: 64,
      minGap: 30,
      maxGap: 80,
      baseGap: 26,
      forkGap: 28,
      sameGap: 22,
      padTop: 40,
    };
  }
  return {
    laneGap: 56,
    padLeft: 36,
    padRight: 88,
    minGap: 40,
    maxGap: 112,
    baseGap: 34,
    forkGap: 36,
    sameGap: 28,
    padTop: 56,
  };
}

export function emptyTimelineLayout(compact?: boolean): TimelineLayoutResult {
  const s = scaleFor(compact);
  return {
    nodes: [],
    edges: [],
    width: compact ? 360 : 480,
    height: compact ? 168 : 220,
    originY: s.padTop,
    padLeft: s.padLeft,
  };
}

/** AI sandbox forks use `ai/…` names (and sometimes matching ids). */
export function isAiBranch(branch: { id?: string | null; name?: string | null } | null | undefined): boolean {
  if (!branch) return false;
  return Boolean(branch.name?.startsWith("ai/") || branch.id?.startsWith("ai/"));
}

/** Strip the `ai/` prefix so timeline chips can show a separate AI badge. */
export function aiBranchLabel(name: string): string {
  return name.startsWith("ai/") ? name.slice(3) : name;
}

export function isImportedGitBranch(
  branch: { importedGit?: boolean; gitRef?: string | null; id?: string | null } | null | undefined,
): boolean {
  if (!branch) return false;
  if (branch.importedGit) return true;
  const ref = branch.gitRef?.trim() ?? "";
  return Boolean(ref) && ref !== "main" && !ref.startsWith("ol/") && Boolean(branch.id?.startsWith("git-"));
}

export function formatWhen(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export function formatTickTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export function shortMsg(msg: string, max = 28): string {
  const t = msg.trim().replace(/\s+/g, " ");
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function compressedGapMs(deltaMs: number, s: Scale): number {
  if (deltaMs <= 0) return s.sameGap;
  const hours = deltaMs / 3_600_000;
  const gap = s.baseGap + Math.log1p(hours) * 16;
  return Math.min(s.maxGap, Math.max(s.minGap, gap));
}

function tickMs(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

/** Reuse a nearby column on another lane so parallel work doesn't stretch the axis. */
function packColumn(minX: number, lane: number, placed: Array<{ x: number; lane: number }>, snap: number): number {
  let best: number | null = null;
  for (const p of placed) {
    if (p.lane === lane) continue;
    if (p.x + 0.5 < minX) continue;
    if (p.x - minX > snap) continue;
    if (best == null || p.x < best) best = p.x;
  }
  return best ?? minX;
}

type AnnoBox = { left: number; right: number; top: number; bottom: number };

function overlaps(a: AnnoBox, b: AnnoBox, pad = 6): boolean {
  return (
    a.left < b.right + pad &&
    a.right + pad > b.left &&
    a.top < b.bottom + pad &&
    a.bottom + pad > b.top
  );
}

function tickBox(x: number, y: number, above: boolean, tier: number, w: number, h: number): AnnoBox {
  const base = 10;
  const step = 16;
  const mid = base + tier * step + h / 2;
  const cy = above ? y - mid : y + mid;
  return { left: x - w / 2, right: x + w / 2, top: cy - h / 2, bottom: cy + h / 2 };
}

function labelBox(x: number, y: number, above: boolean, tier: number, w: number, h: number): AnnoBox {
  const base = 14;
  const step = 20;
  const mid = base + tier * step + h / 2;
  const cy = above ? y - mid : y + mid;
  return { left: x - w / 2, right: x + w / 2, top: cy - h / 2, bottom: cy + h / 2 };
}

/**
 * Guided annotation layout — enough to orient, not enough to replace the dock.
 * - Tips: branch chip (identity).
 * - Sparse leaves: short muted message whisper (teaser → hover).
 * - Thinned times across the graph; short stems elsewhere for cadence.
 * - Full message / author / actions stay in the hover dock.
 */
function deconflictAnnotations(nodes: TimelineLayoutNode[], compact?: boolean): number {
  const tickW = compact ? 64 : 76;
  const tickH = 16;
  const tipLabelH = 15;
  const tipLabelW = compact ? 76 : 92;
  const whisperH = 13;
  const whisperChars = compact ? 12 : 16;
  const whisperW = compact ? 64 : 80;
  const minTickDx = compact ? 56 : 68;
  const minWhisperDx = compact ? 72 : 86;

  for (const n of nodes) {
    const tipSideAbove = n.lane >= 0;
    n.tickAbove = tipSideAbove;
    n.labelAbove = !tipSideAbove;
    n.tickTier = 0;
    n.labelTier = 0;
    n.showTickStem = false;
    n.showTickTime = false;
    n.showLabel = false;
    n.labelMaxChars = 0;
  }

  const byX = [...nodes].sort(
    (a, b) => a.x - b.x || a.y - b.y || a.node.id.localeCompare(b.node.id),
  );
  const tips = byX.filter((n) => n.isHead);
  const placed: AnnoBox[] = [];
  let maxOutward = 0;

  // --- Tip branch chips ---
  for (const n of tips) {
    let placedLabel = false;
    for (const tier of [0, 1, 2] as const) {
      const box = labelBox(n.x, n.y, n.labelAbove, tier, tipLabelW, tipLabelH);
      if (placed.some((p) => overlaps(box, p, 4))) continue;
      n.showLabel = true;
      n.labelTier = tier;
      n.labelMaxChars = 0; // branch chip, not message
      placed.push(box);
      placedLabel = true;
      maxOutward = Math.max(maxOutward, 16 + tier * 22 + tipLabelH);
      break;
    }
    if (!placedLabel) {
      n.showLabel = true;
      n.labelTier = 2;
      n.labelMaxChars = 0;
      maxOutward = Math.max(maxOutward, 16 + 2 * 22 + tipLabelH);
    }
  }

  // --- Sparse message whispers on non-tips (teaser toward hover) ---
  let lastWhisperX = -Infinity;
  for (const n of byX) {
    if (n.isHead) continue; // tips already have a chip
    if (n.x - lastWhisperX < minWhisperDx) continue;
    let placedWhisper = false;
    for (const tier of [0, 1] as const) {
      const box = labelBox(n.x, n.y, n.labelAbove, tier, whisperW, whisperH);
      if (placed.some((p) => overlaps(box, p, 4))) continue;
      n.showLabel = true;
      n.labelTier = tier;
      n.labelMaxChars = whisperChars;
      placed.push(box);
      lastWhisperX = n.x;
      placedWhisper = true;
      maxOutward = Math.max(maxOutward, 14 + tier * 20 + whisperH);
      break;
    }
    void placedWhisper;
  }

  // --- Thinned times (all nodes; tips preferred) ---
  let lastTickX = -Infinity;
  for (const n of byX) {
    const force = n.isHead || n.isSacred;
    if (!force && n.x - lastTickX < minTickDx) {
      n.showTickStem = true; // keep a quiet stem so the leaf still "reads"
      continue;
    }
    let placedTick = false;
    for (const tier of [0, 1] as const) {
      const box = tickBox(n.x, n.y, n.tickAbove, tier, tickW, tickH);
      if (placed.some((p) => overlaps(box, p, 3))) continue;
      n.showTickTime = true;
      n.showTickStem = true;
      n.tickTier = tier;
      placed.push(box);
      lastTickX = n.x;
      placedTick = true;
      maxOutward = Math.max(maxOutward, 8 + tier * 14 + tickH);
      break;
    }
    if (!placedTick) {
      n.showTickStem = true;
      if (force) {
        n.showTickTime = true;
        n.tickTier = 1;
        maxOutward = Math.max(maxOutward, 8 + 14 + tickH);
      }
    }
  }

  // Bare stems for anything still unmarked (fork tips already covered).
  for (const n of nodes) {
    if (!n.showTickStem && !n.showTickTime) n.showTickStem = true;
  }

  return maxOutward;
}

export function layoutTimeline(
  view: TimelineView,
  opts?: { compact?: boolean },
): TimelineLayoutResult {
  const s = scaleFor(opts?.compact);
  const byBranch = new Map<string, TimelineNode[]>();
  for (const n of view.nodes) {
    const list = byBranch.get(n.branchId) ?? [];
    list.push(n);
    byBranch.set(n.branchId, list);
  }
  for (const [, list] of byBranch) {
    list.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  const sacred = view.branches.find((b) => b.sacred) ?? view.branches[0];
  const nodeById = new Map(view.nodes.map((n) => [n.id, n]));

  /** Parent branch of a fork tip (first node whose parent lives on another branch). */
  const parentBranchOf = (branchId: string): string | null => {
    const list = byBranch.get(branchId) ?? [];
    for (const n of list) {
      if (!n.parentId) continue;
      const p = nodeById.get(n.parentId);
      if (p && p.branchId !== branchId) return p.branchId;
    }
    return null;
  };

  /**
   * Pack lanes next to the branch they forked from (not alternate by creation
   * order). That keeps AI / nested forks as a short perpendicular stub instead
   * of wrapping across the sacred spine to the opposite side.
   */
  const laneOf = new Map<string, number>();
  if (sacred) laneOf.set(sacred.id, 0);
  const taken = new Set<number>(sacred ? [0] : []);

  const pickLane = (parentLane: number): number => {
    const sign = parentLane === 0 ? -1 : Math.sign(parentLane) || -1;
    // Prefer: one step outward on the parent's side, then inward, then opposite, then further out.
    const candidates: number[] = [];
    if (parentLane === 0) {
      for (let r = 1; r <= taken.size + 2; r += 1) {
        candidates.push(-r, r);
      }
    } else {
      candidates.push(parentLane + sign);
      if (Math.abs(parentLane) > 1) candidates.push(parentLane - sign);
      candidates.push(-parentLane);
      for (let r = Math.abs(parentLane) + 2; r <= taken.size + 3; r += 1) {
        candidates.push(sign * r, -sign * r);
      }
    }
    for (const c of candidates) {
      if (!taken.has(c)) return c;
    }
    // Fallback: first free integer ≠ 0
    for (let r = 1; r < 64; r += 1) {
      if (!taken.has(-r)) return -r;
      if (!taken.has(r)) return r;
    }
    return parentLane - 1;
  };

  const others = view.branches.filter((b) => b.id !== sacred?.id);
  // Place earlier forks first so nested AI sandboxes sit beside their parent tip.
  others
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .forEach((b) => {
      const pb = parentBranchOf(b.id);
      const parentLane = pb != null ? (laneOf.get(pb) ?? 0) : 0;
      const lane = pickLane(parentLane);
      laneOf.set(b.id, lane);
      taken.add(lane);
    });

  const yOf = (branchId: string) => (laneOf.get(branchId) ?? 0) * s.laneGap;

  const chrono = [...view.nodes].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
  const xOf = new Map<string, number>();
  const lastOnLane = new Map<number, { id: string; x: number; createdAt: string }>();
  const placedCols: Array<{ x: number; lane: number }> = [];
  const colSnap = s.minGap * 0.65;

  for (const node of chrono) {
    const lane = laneOf.get(node.branchId) ?? 0;
    let minX = s.padLeft;
    const parent = node.parentId ? nodeById.get(node.parentId) : undefined;
    const parentX = parent ? xOf.get(parent.id) : undefined;
    if (parent && parentX != null) {
      const fork = parent.branchId !== node.branchId;
      const dt = tickMs(node.createdAt) - tickMs(parent.createdAt);
      minX = Math.max(minX, parentX + (fork ? s.forkGap : compressedGapMs(dt, s)));
    }
    if (node.mergeParentId) {
      const mx = xOf.get(node.mergeParentId);
      if (mx != null) minX = Math.max(minX, mx + s.forkGap);
    }
    const prevLane = lastOnLane.get(lane);
    if (prevLane) {
      const dt = tickMs(node.createdAt) - tickMs(prevLane.createdAt);
      minX = Math.max(minX, prevLane.x + compressedGapMs(dt, s));
    }
    const x = packColumn(minX, lane, placedCols, colSnap);
    xOf.set(node.id, x);
    lastOnLane.set(lane, { id: node.id, x, createdAt: node.createdAt });
    placedCols.push({ x, lane });
  }

  const nodes: TimelineLayoutNode[] = [];
  for (const branch of view.branches) {
    for (const node of byBranch.get(branch.id) ?? []) {
      const x = xOf.get(node.id);
      if (x == null) continue;
      const lane = laneOf.get(branch.id) ?? 0;
      const tickAbove = lane >= 0;
      nodes.push({
        node,
        branch,
        x,
        y: yOf(branch.id),
        isHead: branch.headNodeId === node.id,
        isSacred: Boolean(branch.sacred),
        isAi: isAiBranch(branch),
        lane,
        tickAbove,
        labelAbove: !tickAbove,
        labelTier: 0,
        tickTier: 0,
        showTickStem: true,
        showTickTime: true,
        showLabel: true,
        labelMaxChars: opts?.compact ? 20 : 26,
      });
    }
  }

  const maxAnno = deconflictAnnotations(nodes, opts?.compact);
  const minY = nodes.reduce((m, n) => Math.min(m, n.y), 0);
  const maxY = nodes.reduce((m, n) => Math.max(m, n.y), 0);
  const padY = Math.max(s.padTop, maxAnno + 12);
  const shiftY = padY - minY;
  if (shiftY !== 0) {
    for (const n of nodes) n.y += shiftY;
  }
  const originY = shiftY;

  const edges: TimelineLayoutEdge[] = [];
  for (const l of nodes) {
    if (l.node.parentId) {
      const parent = nodes.find((n) => n.node.id === l.node.parentId);
      if (parent) {
        const fork = parent.node.branchId !== l.node.branchId;
        edges.push({
          id: `${l.node.parentId}->${l.node.id}`,
          x1: parent.x,
          y1: parent.y,
          x2: l.x,
          y2: l.y,
          sacred: l.isSacred && !fork,
          fork,
          ai: l.isAi,
          merge: false,
        });
      }
    }
    // Dotted merge arrow from the source tip into this merge leaf.
    if (l.node.mergeParentId) {
      const src = nodes.find((n) => n.node.id === l.node.mergeParentId);
      if (src) {
        edges.push({
          id: `merge:${l.node.mergeParentId}->${l.node.id}`,
          x1: src.x,
          y1: src.y,
          x2: l.x,
          y2: l.y,
          sacred: false,
          fork: false,
          ai: src.isAi || l.isAi,
          merge: true,
        });
      }
    }
  }

  const maxX = nodes.reduce((m, n) => Math.max(m, n.x), s.padLeft);
  return {
    nodes,
    edges,
    width: maxX + s.padRight,
    height: maxY + shiftY + padY,
    originY,
    padLeft: s.padLeft,
  };
}

/**
 * Draw an edge between two laid-out orbs.
 *
 * Same-lane → straight horizontal.
 * Lane change (fork) → orthogonal elbow: drop/rise at the fork X onto the
 * child lane, then run horizontally. No wrapping S-curves.
 */
export function threadPath(e: TimelineLayoutEdge): string {
  const { x1, y1, x2, y2 } = e;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);

  if (ady < 0.5) {
    return `M ${x1} ${y1} L ${x2} ${y2}`;
  }

  // Small rounded elbow — still axis-aligned, just softens the corner.
  const r = Math.min(7, adx * 0.45, ady * 0.45);
  const sy = dy >= 0 ? 1 : -1;

  if (dx >= -0.5) {
    // Vertical stub at fork, then horizontal on the child lane.
    if (r < 1.5) {
      return `M ${x1} ${y1} L ${x1} ${y2} L ${x2} ${y2}`;
    }
    return `M ${x1} ${y1} L ${x1} ${y2 - sy * r} Q ${x1} ${y2} ${x1 + r} ${y2} L ${x2} ${y2}`;
  }

  // Child left of parent (rare): run back on the parent lane, then drop.
  if (r < 1.5) {
    return `M ${x1} ${y1} L ${x2} ${y1} L ${x2} ${y2}`;
  }
  return `M ${x1} ${y1} L ${x2 + r} ${y1} Q ${x2} ${y1} ${x2} ${y1 + sy * r} L ${x2} ${y2}`;
}

/** Ghost geometry for a not-yet-committed merge (source tip → new leaf on target). */
export function mergePreviewGeometry(
  nodes: TimelineLayoutNode[],
  sourceNodeId: string,
  targetNodeId: string,
  compact?: boolean,
): {
  source: TimelineLayoutNode;
  target: TimelineLayoutNode;
  ghostX: number;
  ghostY: number;
  stem: TimelineLayoutEdge;
  merge: TimelineLayoutEdge;
} | null {
  const source = nodes.find((n) => n.node.id === sourceNodeId);
  const target = nodes.find((n) => n.node.id === targetNodeId);
  if (!source || !target || source.node.id === target.node.id) return null;
  const gap = compact ? 44 : 52;
  const ghostX = target.x + gap;
  const ghostY = target.y;
  return {
    source,
    target,
    ghostX,
    ghostY,
    stem: {
      id: "pending-stem",
      x1: target.x,
      y1: target.y,
      x2: ghostX,
      y2: ghostY,
      sacred: target.isSacred,
      fork: false,
      ai: target.isAi,
      merge: false,
    },
    merge: {
      id: "pending-merge",
      x1: source.x,
      y1: source.y,
      x2: ghostX,
      y2: ghostY,
      sacred: false,
      fork: false,
      ai: source.isAi || target.isAi,
      merge: true,
    },
  };
}

/** Inset endpoints so the stroke meets the orb rim, not the center. */
export function threadPathInset(e: TimelineLayoutEdge, radius = 9): string {
  const dx = e.x2 - e.x1;
  const dy = e.y2 - e.y1;
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);

  if (ady < 0.5) {
    const len = Math.max(adx, 1);
    if (len < radius * 2 + 4) {
      const t0 = Math.min(0.35, radius / len);
      return threadPath({
        ...e,
        x1: e.x1 + dx * t0,
        x2: e.x1 + dx * (1 - t0),
      });
    }
    const sx = dx >= 0 ? 1 : -1;
    return threadPath({
      ...e,
      x1: e.x1 + sx * radius,
      x2: e.x2 - sx * radius,
    });
  }

  const sy = dy >= 0 ? 1 : -1;
  const insetY = Math.min(radius, ady * 0.4);

  // Forward fork: leave parent vertically, enter child horizontally.
  if (dx >= -0.5) {
    const insetX = Math.min(radius, Math.max(adx, 1) * 0.4);
    const y1 = e.y1 + sy * insetY;
    const x2 = adx < radius ? e.x2 : e.x2 - insetX;
    return threadPath({ ...e, y1, x2: Math.max(x2, e.x1) });
  }

  // Backward fork: leave parent horizontally, enter child vertically.
  const insetX = Math.min(radius, adx * 0.4);
  return threadPath({
    ...e,
    x1: e.x1 - insetX,
    y2: e.y2 - sy * insetY,
  });
}
