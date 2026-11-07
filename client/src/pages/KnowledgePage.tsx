import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import { quadtree } from "d3-quadtree";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  getKnowledgeGraph,
  getKnowledgeInbox,
  getKnowledgeNeighborhood,
  listKnowledgeItems,
  searchKnowledgeIndex,
  type KnowledgeGraph,
  type KnowledgeGraphEdge,
  type KnowledgeGraphNode,
  type KnowledgeStatus,
} from "../api/client";
import { hostLogout } from "../api/share";
import { ErrorBanner } from "../components/ErrorBanner";
import { ThemePicker } from "../components/ThemeToggle";
import { KnowledgeDependencyReview } from "../components/KnowledgeDependencyReview";
import { openNodeFromGraph, openNodeHref } from "../lib/knowledgeLinks";
import { readLastProject, type LastProject } from "../lib/lastProject";
import { useSession } from "../session/SessionContext";

const LAYOUT_KEY = "openleaf.knowledge.layout";

type SimNode = SimulationNodeDatum &
  KnowledgeGraphNode & {
    r: number;
    vx?: number;
    vy?: number;
    fx?: number | null;
    fy?: number | null;
  };

type SimLink = SimulationLinkDatum<SimNode> & { flagged: boolean };

type KindKey = KnowledgeGraphNode["kind"];

type LayoutStore = Record<string, { x: number; y: number }>;

function readLayout(): LayoutStore {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as LayoutStore;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeLayout(nodes: SimNode[]) {
  const next: LayoutStore = {};
  for (const n of nodes) {
    if (n.x == null || n.y == null) continue;
    next[n.id] = { x: n.x, y: n.y };
  }
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(next));
  } catch {
    /* quota */
  }
}

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function kindColor(kind: KindKey): string {
  if (kind === "fact") return cssVar("--kind-fact", "#5ec4b6");
  if (kind === "knowledge") return cssVar("--kind-knowledge", "#a78bfa");
  if (kind === "project") return cssVar("--kind-project", "#e2a35a");
  return cssVar("--kind-source", "#8a96a3");
}

function kindLabel(kind: KindKey): string {
  if (kind === "project") return "Paper";
  if (kind === "knowledge") return "Knowledge";
  if (kind === "fact") return "Fact";
  return "Source";
}

/** Draw node geometry: papers = rounded square, knowledge = double ring, facts/sources = circle/diamond. */
function strokeNodeShape(
  ctx: CanvasRenderingContext2D,
  kind: KindKey,
  x: number,
  y: number,
  r: number,
): void {
  if (kind === "project") {
    const s = r * 1.05;
    const rad = Math.max(2, r * 0.28);
    ctx.beginPath();
    ctx.roundRect(x - s, y - s, s * 2, s * 2, rad);
    return;
  }
  if (kind === "knowledge") {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    return;
  }
  if (kind === "source") {
    ctx.beginPath();
    ctx.moveTo(x, y - r);
    ctx.lineTo(x + r * 0.75, y);
    ctx.lineTo(x, y + r);
    ctx.lineTo(x - r * 0.75, y);
    ctx.closePath();
    return;
  }
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
}

function statusNeedsAttention(status: KnowledgeStatus): boolean {
  return status === "needs-review" || status === "unreviewed" || status === "flagged" || status === "rejected";
}

function statusLabel(status: KnowledgeStatus): string {
  switch (status) {
    case "needs-review":
      return "Needs review";
    case "unreviewed":
      return "Unreviewed";
    case "up-to-date":
      return "Up to date";
    case "flagged":
      return "Flagged";
    case "rejected":
      return "Rejected";
    case "confirmed":
      return "Confirmed";
    case "reviewed":
      return "Reviewed";
    default:
      return status.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }
}

function isDetailKind(kind: KnowledgeGraphNode["kind"]): boolean {
  return kind === "fact" || kind === "source";
}

function mergeGraphPatch(
  base: KnowledgeGraph,
  patch: { nodes: KnowledgeGraphNode[]; edges: KnowledgeGraphEdge[] } | null,
): KnowledgeGraph {
  if (!patch?.nodes.length) return base;
  const byId = new Map(base.nodes.map((n) => [n.id, n]));
  for (const n of patch.nodes) byId.set(n.id, n);
  const edgeKey = (e: KnowledgeGraphEdge) => `${e.from}->${e.to}`;
  const edges = new Map(base.edges.map((e) => [edgeKey(e), e]));
  for (const e of patch.edges) edges.set(edgeKey(e), e);
  const collections = new Set(base.collections);
  for (const n of patch.nodes) collections.add(n.collection);
  return {
    nodes: [...byId.values()],
    edges: [...edges.values()],
    collections: [...collections].sort(),
    generatedAt: base.generatedAt,
  };
}

function nodeRadius(n: KnowledgeGraphNode): number {
  if (n.kind === "source") return 5;
  if (n.kind === "fact") return 6.5;
  if (n.kind === "project") return 14;
  // Knowledge: slightly larger than facts, smaller than papers.
  return 10 + Math.min(4, (n.outputs?.length ?? 0) * 1.2);
}

/** Prefer English `note`/name; never show raw slug keys in the UI. */
function displayLabel(n: KnowledgeGraphNode, maxLen = 44): string {
  const raw = (n.name || n.note || n.id).trim();
  if (!raw) return n.id;
  // Old cached graphs may still have slug names — soften them client-side.
  const looksLikeSlug = /^[a-z][a-z0-9]+(?:-[a-z0-9]+)+$/.test(raw);
  let text = raw;
  if (looksLikeSlug && n.note?.trim()) {
    const m = n.note.match(/^(AUROC|AUC|C-index|accuracy|F1)\s+of\s+(.+?)(?:\s+on\s+(.+))?$/i);
    if (m) {
      const model = m[2]!.trim();
      const dataset = (m[3] || "").trim().replace(/\s*\([^)]*\)\s*$/, "");
      text = dataset ? `${model} on ${dataset}` : `${m[1]} of ${model}`;
    } else {
      text = n.note.trim();
    }
  } else if (looksLikeSlug) {
    text = raw
      .split("-")
      .map((w, i) => {
        if (["of", "on", "for", "and", "the", "a", "an", "vs", "to", "in", "per", "by"].includes(w) && i > 0) {
          return w;
        }
        if (["auroc", "auc", "f1", "tcga", "nsclc", "luad", "lusc", "abmil", "clam", "dsmil", "mil"].includes(w)) {
          return w.toUpperCase();
        }
        return w.charAt(0).toUpperCase() + w.slice(1);
      })
      .join(" ")
      .replace(/\s+(\d+)$/, " ($1)");
  }
  text = text.replace(/\s+/g, " ").trim();
  if (text.length > maxLen) return `${text.slice(0, maxLen - 1).trimEnd()}…`;
  return text;
}

function labelPriority(n: KnowledgeGraphNode, focusId: string | null, lit: Set<string> | null): number {
  if (focusId && n.id === focusId) return 100;
  if (lit?.has(n.id) && n.kind === "knowledge") return 90;
  if (n.kind === "knowledge") return 80;
  if (n.kind === "project") return 70;
  if (lit?.has(n.id)) return 60;
  if (n.kind === "source") return 40;
  return 20;
}


function shortestPath(adj: Map<string, string[]>, from: string, to: string): string[] | null {
  if (from === to) return [from];
  const q = [from];
  const prev = new Map<string, string | null>([[from, null]]);
  while (q.length) {
    const cur = q.shift()!;
    for (const nxt of adj.get(cur) ?? []) {
      if (prev.has(nxt)) continue;
      prev.set(nxt, cur);
      if (nxt === to) {
        const path: string[] = [];
        let walk: string | null = to;
        while (walk) {
          path.push(walk);
          walk = prev.get(walk) ?? null;
        }
        return path.reverse();
      }
      q.push(nxt);
    }
  }
  return null;
}

function branchSet(
  focusId: string,
  depth: "1" | "2" | "all",
  inputs: Map<string, string[]>,
  outputs: Map<string, string[]>,
): Set<string> {
  const out = new Set<string>([focusId]);
  const maxD = depth === "all" ? 99 : Number(depth);
  for (const dir of [inputs, outputs] as const) {
    let frontier = [focusId];
    for (let d = 0; d < maxD && frontier.length; d += 1) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const o of dir.get(id) ?? []) {
          if (!out.has(o)) {
            out.add(o);
            next.push(o);
          }
        }
      }
      frontier = next;
    }
  }
  return out;
}

export function KnowledgePage() {
  const { session, refresh } = useSession();
  const remoteHost = session.kind === "host" && session.remote;
  const [params, setParams] = useSearchParams();
  const [baseGraph, setBaseGraph] = useState<KnowledgeGraph | null>(null);
  const [revealPatch, setRevealPatch] = useState<{
    nodes: KnowledgeGraphNode[];
    edges: KnowledgeGraphEdge[];
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [revealing, setRevealing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inboxCount, setInboxCount] = useState(0);
  const [lastProject, setLastProject] = useState<LastProject | null>(null);
  const [projectByKn, setProjectByKn] = useState<Map<string, string>>(() => new Map());

  const [zoom, setZoom] = useState(1);
  const [vx, setVx] = useState(0);
  const [vy, setVy] = useState(0);
  const [anim, setAnim] = useState(false);
  const [panelWidth, setPanelWidth] = useState(() => {
    const n = Number(localStorage.getItem("openleaf.knowledgePanelWidth") ?? 380);
    return Number.isFinite(n) ? Math.min(640, Math.max(280, n)) : 380;
  });
  const panelWidthRef = useRef(panelWidth);
  panelWidthRef.current = panelWidth;
  const [panelCollapsed, setPanelCollapsed] = useState(
    () => localStorage.getItem("openleaf.knowledgePanelCollapsed") === "1",
  );
  const [panelDragging, setPanelDragging] = useState(false);
  const mainRef = useRef<HTMLDivElement | null>(null);
  const [focus, setFocus] = useState<string | null>(params.get("focus"));
  const [depth, setDepth] = useState<"1" | "2" | "all">("2");
  const [kinds, setKinds] = useState<Record<KindKey, boolean>>({
    source: true,
    fact: true,
    knowledge: true,
    project: true,
  });
  /** When false (default), facts/sources stay hidden until focus reveals them. */
  const [alwaysShowDetails, setAlwaysShowDetails] = useState(false);
  const [attention, setAttention] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);

  const graph = useMemo(
    () => (baseGraph ? mergeGraphPatch(baseGraph, revealPatch) : null),
    [baseGraph, revealPatch],
  );
  const [labels, setLabels] = useState<"auto" | "all" | "off">("auto");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [q, setQ] = useState("");
  const [pathMode, setPathMode] = useState(false);
  const [pathTo, setPathTo] = useState<string | null>(null);
  const [hover, setHover] = useState<{ id: string; sx: number; sy: number } | null>(null);
  const [tick, setTick] = useState(0);

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const miniRef = useRef<HTMLCanvasElement | null>(null);
  const simRef = useRef<Simulation<SimNode, SimLink> | null>(null);
  const nodesRef = useRef<SimNode[]>([]);
  const linksRef = useRef<SimLink[]>([]);
  const byIdRef = useRef<Map<string, SimNode>>(new Map());
  const panRef = useRef<{ sx: number; sy: number; vx: number; vy: number } | null>(null);
  const dragRef = useRef<{ id: string; sx: number; sy: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const didInitialFit = useRef(false);
  const focusIdRef = useRef<string | null>(focus);
  const cameraRef = useRef({ zoom, vx, vy, anim });
  const uiRef = useRef({
    focus,
    depth,
    kinds,
    attention,
    labels,
    collapsed,
    pathTo,
    alwaysShowDetails,
  });

  cameraRef.current = { zoom, vx, vy, anim };
  focusIdRef.current = focus;
  uiRef.current = { focus, depth, kinds, attention, labels, collapsed, pathTo, alwaysShowDetails };

  useEffect(() => {
    setLastProject(readLastProject());
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    // Graph first for a fast first paint; inbox/items fill in after.
    void getKnowledgeGraph()
      .then((g) => {
        if (cancelled) return;
        setBaseGraph(g);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoading(false);
        setError(err instanceof Error ? err.message : "Could not load knowledge graph");
      });
    void Promise.all([getKnowledgeInbox(), listKnowledgeItems()])
      .then(([inbox, items]) => {
        if (cancelled) return;
        setInboxCount(inbox.groups.reduce((n, gr) => n + gr.items.length, 0));
        const map = new Map<string, string>();
        for (const it of items.items) map.set(it.knowledgeId, it.id);
        setProjectByKn(map);
      })
      .catch(() => {
        /* non-fatal for the canvas */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Build / refresh simulation when graph data changes.
  // Do NOT refit the camera on incremental neighborhood hydrates — that zooms the user out.
  useEffect(() => {
    if (!graph) return;
    const saved = readLayout();
    const prevById = byIdRef.current;
    const incremental = prevById.size > 0;
    const anchor = focusIdRef.current ? prevById.get(focusIdRef.current) : null;
    const colCenters = new Map<string, { x: number; y: number }>();
    graph.collections.forEach((c, i) => {
      const angle = (i / Math.max(1, graph.collections.length)) * Math.PI * 2;
      colCenters.set(c, { x: Math.cos(angle) * 280, y: Math.sin(angle) * 220 });
    });

    const nodes: SimNode[] = graph.nodes.map((n, i) => {
      const prev = prevById.get(n.id);
      if (prev) {
        return {
          ...n,
          r: nodeRadius(n),
          x: prev.x,
          y: prev.y,
          vx: prev.vx,
          vy: prev.vy,
        };
      }
      const c = colCenters.get(n.collection) ?? { x: 0, y: 0 };
      const pos = saved[n.id];
      // New neighborhood nodes spawn near the focused node (or collection center).
      const jitter = ((Math.sin(i * 12.9898) * 10000) % 40) - 20;
      const jitterY = ((Math.cos(i * 78.233) * 10000) % 40) - 20;
      return {
        ...n,
        r: nodeRadius(n),
        x: pos?.x ?? (anchor?.x ?? c.x) + jitter,
        y: pos?.y ?? (anchor?.y ?? c.y) + jitterY,
      };
    });
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const links: SimLink[] = [];
    for (const e of graph.edges) {
      const s = byId.get(e.from);
      const t = byId.get(e.to);
      if (!s || !t) continue;
      links.push({ source: s, target: t, flagged: e.flagged });
    }

    nodesRef.current = nodes;
    linksRef.current = links;
    byIdRef.current = byId;

    simRef.current?.stop();
    const sim = forceSimulation(nodes)
      .force(
        "link",
        forceLink<SimNode, SimLink>(links)
          .id((d) => d.id)
          .distance((l) => {
            const a = l.source as SimNode;
            const b = l.target as SimNode;
            if (a.kind === "source") return 34;
            if (b.kind === "project") return 84;
            if (a.kind === "knowledge") return 72;
            return 58;
          })
          .strength(0.35),
      )
      .force("charge", forceManyBody().strength(-180))
      .force("collide", forceCollide<SimNode>().radius((d) => d.r + 4).iterations(2))
      .force("center", forceCenter(0, 0).strength(incremental ? 0.01 : 0.04))
      .force(
        "x",
        forceX<SimNode>((d) => colCenters.get(d.collection)?.x ?? 0).strength(incremental ? 0.01 : 0.04),
      )
      .force(
        "y",
        forceY<SimNode>((d) => colCenters.get(d.collection)?.y ?? 0).strength(incremental ? 0.01 : 0.04),
      )
      .alpha(incremental ? 0.2 : 0.85)
      .alphaDecay(0.028);

    sim.on("tick", () => setTick((t) => t + 1));
    sim.on("end", () => writeLayout(nodesRef.current));
    simRef.current = sim;

    let t: number | undefined;
    if (!didInitialFit.current) {
      t = window.setTimeout(() => {
        fitTo(nodes, false);
        didInitialFit.current = true;
      }, 80);
    }

    return () => {
      if (t != null) window.clearTimeout(t);
      sim.stop();
      writeLayout(nodesRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fitTo stable via refs
  }, [graph]);

  const inputsMap = useMemo(() => {
    const m = new Map<string, string[]>();
    if (!graph) return m;
    for (const n of graph.nodes) m.set(n.id, n.inputs ?? []);
    return m;
  }, [graph]);

  const outputsMap = useMemo(() => {
    const m = new Map<string, string[]>();
    if (!graph) return m;
    for (const e of graph.edges) {
      const list = m.get(e.from) ?? [];
      list.push(e.to);
      m.set(e.from, list);
    }
    for (const n of graph.nodes) {
      if (!m.has(n.id)) m.set(n.id, n.outputs ?? []);
    }
    return m;
  }, [graph]);

  const undirectedAdj = useMemo(() => {
    const m = new Map<string, string[]>();
    if (!graph) return m;
    const add = (a: string, b: string) => {
      const la = m.get(a) ?? [];
      la.push(b);
      m.set(a, la);
    };
    for (const e of graph.edges) {
      add(e.from, e.to);
      add(e.to, e.from);
    }
    return m;
  }, [graph]);

  const pathIds = useMemo(() => {
    if (!focus || !pathTo) return null;
    return shortestPath(undirectedAdj, focus, pathTo);
  }, [focus, pathTo, undirectedAdj]);

  const focusedBranch = useMemo(() => {
    if (!focus) return null;
    return branchSet(focus, depth, inputsMap, outputsMap);
  }, [focus, depth, inputsMap, outputsMap]);

  // Progressive disclosure: hydrate sibling facts from sources in the focused branch.
  useEffect(() => {
    if (!focus) {
      setRevealPatch(null);
      setRevealing(false);
      return;
    }
    let cancelled = false;
    setRevealing(true);
    const d = depth === "all" ? 4 : Number(depth);
    void getKnowledgeNeighborhood(focus, d)
      .then((patch) => {
        if (cancelled) return;
        setRevealPatch(patch);
        setRevealing(false);
      })
      .catch(() => {
        if (cancelled) return;
        setRevealPatch(null);
        setRevealing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [focus, depth]);

  const nodeIsVisible = useCallback(
    (n: KnowledgeGraphNode, _lit: Set<string> | null, _path: Set<string> | null) => {
      if (collapsed[n.collection]) return false;
      if (!kinds[n.kind]) return false;
      if (attention && !statusNeedsAttention(n.status)) return false;
      return true;
    },
    [collapsed, kinds, attention],
  );

  /** Bright = primary tree / focused branch. Everything else stays faintly visible. */
  const nodeIsBright = useCallback(
    (n: KnowledgeGraphNode, lit: Set<string> | null, path: Set<string> | null) => {
      if (n.inTree === false && !alwaysShowDetails) {
        if (focus === n.id) return true;
        if (lit?.has(n.id)) return true;
        if (path?.has(n.id)) return true;
        return false;
      }
      if (isDetailKind(n.kind) && !alwaysShowDetails) {
        if (!focus) return false;
        if (lit?.has(n.id)) return true;
        if (path?.has(n.id)) return true;
        return false;
      }
      if (lit && !lit.has(n.id) && !(path?.has(n.id))) return false;
      return true;
    },
    [alwaysShowDetails, focus],
  );

  const visibleNodes = useCallback(() => {
    const path = pathIds ? new Set(pathIds) : null;
    return nodesRef.current.filter((n) => nodeIsVisible(n, focusedBranch, path));
  }, [nodeIsVisible, focusedBranch, pathIds]);

  const fitTo = useCallback((list: SimNode[], animate: boolean) => {
    const wrap = wrapRef.current;
    if (!wrap || !list.length) return;
    const W = wrap.clientWidth;
    const H = wrap.clientHeight;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const n of list) {
      const x = n.x ?? 0;
      const y = n.y ?? 0;
      x0 = Math.min(x0, x - n.r);
      y0 = Math.min(y0, y - n.r);
      x1 = Math.max(x1, x + n.r);
      y1 = Math.max(y1, y + n.r);
    }
    // Extra padding so labels on the left edge are not clipped (overnight #9).
    const z = Math.max(0.3, Math.min(2.0, Math.min(W / (x1 - x0 + 360), H / (y1 - y0 + 280))));
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const nvx = W / 2 - cx * z;
    const nvy = H / 2 - cy * z;
    setZoom(z);
    setVx(nvx);
    setVy(nvy);
    if (animate) {
      setAnim(true);
      window.setTimeout(() => setAnim(false), 650);
    }
  }, []);

  const centerOn = useCallback((x: number, y: number, z: number) => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    setZoom(z);
    setVx(wrap.clientWidth / 2 - x * z);
    setVy(wrap.clientHeight / 2 - y * z);
    setAnim(true);
    window.setTimeout(() => setAnim(false), 650);
  }, []);

  const focusOn = useCallback(
    (id: string, center: boolean) => {
      const n = byIdRef.current.get(id);
      if (!n) return;
      setCollapsed((c) => (c[n.collection] ? { ...c, [n.collection]: false } : c));
      setKinds((k) => (!k[n.kind] ? { ...k, [n.kind]: true } : k));
      setFocus(id);
      setPathTo(null);
      setPathMode(false);
      setMoreOpen(false);
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set("focus", id);
          return next;
        },
        { replace: true },
      );
      if (center) centerOn(n.x ?? 0, n.y ?? 0, Math.max(cameraRef.current.zoom, 1.1));
      // Trail / focus details need a readable column — reopen and widen if crushed.
      setPanelCollapsed(false);
      localStorage.setItem("openleaf.knowledgePanelCollapsed", "0");
      setPanelWidth((w) => Math.max(w, 360));
    },
    [centerOn, setParams],
  );

  useEffect(() => {
    if (!panelDragging || panelCollapsed) return;
    const onMove = (e: PointerEvent) => {
      const el = mainRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const fromRight = rect.right - e.clientX;
      const w = Math.min(640, Math.max(280, fromRight));
      setPanelWidth(w);
    };
    const onUp = () => {
      setPanelDragging(false);
      localStorage.setItem("openleaf.knowledgePanelWidth", String(panelWidthRef.current));
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [panelDragging, panelCollapsed]);

  const togglePanelCollapsed = useCallback(() => {
    setPanelCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem("openleaf.knowledgePanelCollapsed", next ? "1" : "0");
      return next;
    });
  }, []);

  // Draw
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = wrap.clientWidth;
    const H = wrap.clientHeight;
    canvas.width = Math.max(1, Math.floor(W * dpr));
    canvas.height = Math.max(1, Math.floor(H * dpr));
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const cam = cameraRef.current;
    const ui = uiRef.current;
    const nodes = nodesRef.current;
    const links = linksRef.current;

    const lit = ui.focus ? focusedBranch : null;
    const pathSet = pathIds ? new Set(pathIds) : null;

    const visible = new Set(
      nodes
        .filter((n) => {
          if (ui.collapsed[n.collection] || !ui.kinds[n.kind]) return false;
          if (ui.attention && !statusNeedsAttention(n.status)) return false;
          return true;
        })
        .map((n) => n.id),
    );

    const brightOf = (n: KnowledgeGraphNode): boolean => {
      if (n.inTree === false && !ui.alwaysShowDetails) {
        if (ui.focus === n.id) return true;
        if (lit?.has(n.id)) return true;
        if (pathSet?.has(n.id)) return true;
        return false;
      }
      if (isDetailKind(n.kind) && !ui.alwaysShowDetails) {
        if (!ui.focus) return false;
        if (lit?.has(n.id)) return true;
        if (pathSet?.has(n.id)) return true;
        return false;
      }
      if (lit && !lit.has(n.id) && !(pathSet?.has(n.id))) return false;
      return true;
    };

    // Collection bubbles when collapsed
    const collapsedCenters = new Map<string, { x: number; y: number; count: number; flag: boolean }>();
    for (const n of nodes) {
      if (!ui.collapsed[n.collection]) continue;
      const cur = collapsedCenters.get(n.collection) ?? { x: 0, y: 0, count: 0, flag: false };
      cur.x += n.x ?? 0;
      cur.y += n.y ?? 0;
      cur.count += 1;
      if (statusNeedsAttention(n.status)) cur.flag = true;
      collapsedCenters.set(n.collection, cur);
    }
    for (const [col, c] of collapsedCenters) {
      c.x /= c.count;
      c.y /= c.count;
      collapsedCenters.set(col, c);
    }

    const nodePos = (id: string): { x: number; y: number; r: number; bubble?: string } | null => {
      const n = byIdRef.current.get(id);
      if (!n) return null;
      if (ui.collapsed[n.collection]) {
        const c = collapsedCenters.get(n.collection);
        if (!c) return null;
        return { x: c.x, y: c.y, r: 18 + Math.min(10, Math.sqrt(c.count) * 3), bubble: n.collection };
      }
      if (!visible.has(id)) return null;
      return { x: n.x ?? 0, y: n.y ?? 0, r: n.r };
    };

    ctx.save();
    ctx.translate(cam.vx, cam.vy);
    ctx.scale(cam.zoom, cam.zoom);

    // Edges — faint atmosphere first, bright links on top
    for (const link of links) {
      const a = link.source as SimNode;
      const b = link.target as SimNode;
      const pa = nodePos(a.id);
      const pb = nodePos(b.id);
      if (!pa || !pb) continue;
      if (pa.bubble && pb.bubble && pa.bubble === pb.bubble) continue;
      const onPath = pathSet ? pathSet.has(a.id) && pathSet.has(b.id) : false;
      const bright = brightOf(a) && brightOf(b);
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      if (link.flagged || onPath) {
        ctx.strokeStyle = cssVar("--status-flag", "#e0a04b");
        ctx.setLineDash([5, 4]);
        ctx.lineWidth = 1.6 / cam.zoom;
        ctx.globalAlpha = 0.9;
      } else {
        const grad = ctx.createLinearGradient(pa.x, pa.y, pb.x, pb.y);
        grad.addColorStop(0, kindColor(a.kind));
        grad.addColorStop(1, kindColor(b.kind));
        ctx.strokeStyle = grad;
        ctx.setLineDash([]);
        ctx.lineWidth = (bright ? 1.25 : 0.55) / cam.zoom;
        ctx.globalAlpha = bright ? 0.7 : 0.1;
      }
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }

    // Collapsed bubbles
    for (const [col, c] of collapsedCenters) {
      ctx.beginPath();
      ctx.arc(c.x, c.y, 18 + Math.min(10, Math.sqrt(c.count) * 3), 0, Math.PI * 2);
      ctx.fillStyle = cssVar("--bg-elevated", "#13181e");
      ctx.strokeStyle = c.flag ? cssVar("--status-flag", "#e0a04b") : cssVar("--line-strong", "#2c3642");
      ctx.lineWidth = 2 / cam.zoom;
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = cssVar("--ink", "#eef2f6");
      ctx.font = `650 ${12 / cam.zoom}px var(--font), sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(c.count), c.x, c.y);
      ctx.font = `600 ${9 / cam.zoom}px var(--font), sans-serif`;
      ctx.fillStyle = cssVar("--ink-muted", "#8a96a3");
      ctx.fillText(col.toUpperCase(), c.x, c.y + 22 / cam.zoom);
      ctx.textAlign = "start";
      ctx.textBaseline = "alphabetic";
    }

    // Nodes
    const flagColor = cssVar("--status-flag", "#e0a04b");
    const rejectColor = cssVar("--status-reject", "#e87979");
    const checked =
      (s: KnowledgeStatus) => s === "confirmed" || s === "reviewed" || s === "up-to-date";

    for (const n of nodes) {
      if (!visible.has(n.id) || ui.collapsed[n.collection]) continue;
      const x = n.x ?? 0;
      const y = n.y ?? 0;
      const bright = brightOf(n);
      const onPath = pathSet?.has(n.id);
      const ghost = !bright;
      const drawR = ghost ? Math.max(2.2, n.r * 0.55) : n.r;
      ctx.globalAlpha = ghost ? 0.16 : 1;

      if (!ghost && (n.status === "flagged" || onPath)) {
        strokeNodeShape(ctx, n.kind, x, y, drawR + 4);
        ctx.strokeStyle = flagColor;
        ctx.lineWidth = 2 / cam.zoom;
        ctx.globalAlpha *= 0.85;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      const fill = kindColor(n.kind);
      if (ghost) {
        strokeNodeShape(ctx, n.kind, x, y, drawR);
        ctx.fillStyle = fill;
        ctx.globalAlpha = 0.14;
        ctx.fill();
        ctx.globalAlpha = 0.22;
        ctx.strokeStyle = fill;
        ctx.lineWidth = 1 / cam.zoom;
        ctx.stroke();
      } else if (n.kind === "knowledge") {
        // Knowledge: filled disc + outer ring — reads differently from paper squares.
        strokeNodeShape(ctx, n.kind, x, y, drawR);
        ctx.fillStyle = cssVar("--bg-elevated", "#13181e");
        ctx.fill();
        ctx.strokeStyle = fill;
        ctx.lineWidth = 2.4 / cam.zoom;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(x, y, Math.max(2.5, drawR * 0.45), 0, Math.PI * 2);
        ctx.fillStyle = n.status === "rejected" ? rejectColor : fill;
        ctx.globalAlpha = checked(n.status) || n.status === "rejected" ? 0.95 : 0.75;
        ctx.fill();
        ctx.globalAlpha = 1;
      } else if (n.status === "rejected") {
        strokeNodeShape(ctx, n.kind, x, y, drawR);
        ctx.fillStyle = rejectColor;
        ctx.globalAlpha *= 0.9;
        ctx.fill();
      } else if (checked(n.status) || n.kind === "project") {
        strokeNodeShape(ctx, n.kind, x, y, drawR);
        ctx.fillStyle = fill;
        ctx.fill();
        if (n.kind === "project") {
          ctx.strokeStyle = cssVar("--bg", "#0b0e11");
          ctx.lineWidth = 1.5 / cam.zoom;
          ctx.stroke();
        }
      } else {
        strokeNodeShape(ctx, n.kind, x, y, drawR);
        ctx.fillStyle = cssVar("--bg-elevated", "#13181e");
        ctx.fill();
        ctx.strokeStyle = fill;
        ctx.lineWidth = 2 / cam.zoom;
        ctx.stroke();
      }

      ctx.globalAlpha = 1;
    }

    // Labels in a second pass with collision avoidance (no overlapping text).
    type LabelBox = { x0: number; y0: number; x1: number; y1: number };
    const placed: LabelBox[] = [];
    const gap = 10 / cam.zoom;
    const overlaps = (a: LabelBox, b: LabelBox) =>
      !(a.x1 + gap < b.x0 || b.x1 + gap < a.x0 || a.y1 + gap < b.y0 || b.y1 + gap < a.y0);

    const labelCandidates = nodes
      .filter((n) => {
        if (!visible.has(n.id) || ui.collapsed[n.collection]) return false;
        if (!brightOf(n)) return false;
        if (ui.labels === "off") return false;
        if (ui.labels === "all") return true;
        if (focus === n.id) return true;
        if (focus) {
          // Focused branch: keep knowledge + paper labels on lit nodes so the paper is never nameless.
          if (n.kind === "knowledge" || n.kind === "project") return Boolean(lit?.has(n.id));
          return Boolean(lit?.has(n.id)) && cam.zoom >= 1.2;
        }
        return n.kind === "knowledge" || n.kind === "project";
      })
      .sort(
        (a, b) =>
          labelPriority(b, focus, lit) - labelPriority(a, focus, lit) ||
          a.name.localeCompare(b.name),
      );

    // Keep labels proportional to the rest of the UI (overnight #9 — was oversized).
    const fontPx = Math.min(12, Math.max(9, 10 / Math.sqrt(Math.max(cam.zoom, 0.5))));
    ctx.font = `500 ${fontPx}px var(--font), sans-serif`;
    const maxLabels = ui.labels === "all" ? 60 : focus ? 18 : 12;
    let drawnLabels = 0;

    for (const n of labelCandidates) {
      if (drawnLabels >= maxLabels) break;
      const x = n.x ?? 0;
      const y = n.y ?? 0;
      const drawR = n.r;
      const text = displayLabel(n, n.kind === "fact" ? 32 : 40);
      const tw = ctx.measureText(text).width;
      const th = fontPx * 1.35;
      const slot = 14 / cam.zoom;
      const offsets: Array<{ dx: number; dy: number; align: CanvasTextAlign }> = [
        { dx: drawR + 6 / cam.zoom, dy: fontPx * 0.35, align: "left" },
        { dx: drawR + 6 / cam.zoom, dy: fontPx * 0.35 - slot, align: "left" },
        { dx: drawR + 6 / cam.zoom, dy: fontPx * 0.35 + slot, align: "left" },
        { dx: -(drawR + 6 / cam.zoom), dy: fontPx * 0.35, align: "right" },
        { dx: -(drawR + 6 / cam.zoom), dy: fontPx * 0.35 - slot, align: "right" },
        { dx: -(drawR + 6 / cam.zoom), dy: fontPx * 0.35 + slot, align: "right" },
        { dx: 0, dy: -(drawR + 8 / cam.zoom), align: "center" },
        { dx: 0, dy: drawR + fontPx + 6 / cam.zoom, align: "center" },
      ];
      let chosen: { box: LabelBox; ox: number; oy: number; align: CanvasTextAlign } | null = null;
      for (const off of offsets) {
        const tx = x + off.dx;
        const ty = y + off.dy;
        const x0 =
          off.align === "left" ? tx : off.align === "right" ? tx - tw : tx - tw / 2;
        const box: LabelBox = { x0, y0: ty - th * 0.85, x1: x0 + tw, y1: ty + th * 0.35 };
        if (placed.some((p) => overlaps(box, p))) continue;
        chosen = { box, ox: tx, oy: ty, align: off.align };
        break;
      }
      // Focused node always gets a label even if crowded — push others aside by forcing place.
      if (!chosen && focus === n.id) {
        const tx = x + drawR + 6 / cam.zoom;
        const ty = y + fontPx * 0.35;
        chosen = {
          box: { x0: tx, y0: ty - th * 0.85, x1: tx + tw, y1: ty + th * 0.35 },
          ox: tx,
          oy: ty,
          align: "left",
        };
      }
      if (!chosen) continue;
      placed.push(chosen.box);
      drawnLabels += 1;

      const bg = cssVar("--bg", "#0b0e11");
      ctx.globalAlpha = 0.78;
      ctx.fillStyle = bg;
      ctx.fillRect(
        chosen.box.x0 - 3 / cam.zoom,
        chosen.box.y0 - 2 / cam.zoom,
        tw + 6 / cam.zoom,
        th + 3 / cam.zoom,
      );
      ctx.globalAlpha = 0.96;
      ctx.fillStyle = cssVar("--ink", "#eef2f6");
      ctx.textAlign = chosen.align;
      ctx.textBaseline = "alphabetic";
      ctx.fillText(text, chosen.ox, chosen.oy);
      ctx.textAlign = "start";
      ctx.globalAlpha = 1;
    }

    ctx.restore();

    // Minimap
    const mini = miniRef.current;
    if (mini) {
      const mw = mini.clientWidth || 148;
      const mh = mini.clientHeight || 100;
      const mdpr = Math.min(window.devicePixelRatio || 1, 2);
      mini.width = Math.floor(mw * mdpr);
      mini.height = Math.floor(mh * mdpr);
      const mctx = mini.getContext("2d");
      if (mctx && nodes.length) {
        mctx.setTransform(mdpr, 0, 0, mdpr, 0, 0);
        mctx.clearRect(0, 0, mw, mh);
        let x0 = Infinity;
        let y0 = Infinity;
        let x1 = -Infinity;
        let y1 = -Infinity;
        for (const n of nodes) {
          x0 = Math.min(x0, n.x ?? 0);
          y0 = Math.min(y0, n.y ?? 0);
          x1 = Math.max(x1, n.x ?? 0);
          y1 = Math.max(y1, n.y ?? 0);
        }
        const pad = 40;
        const scale = Math.min(mw / (x1 - x0 + pad * 2), mh / (y1 - y0 + pad * 2));
        const ox = (mw - (x1 - x0) * scale) / 2 - x0 * scale;
        const oy = (mh - (y1 - y0) * scale) / 2 - y0 * scale;
        mctx.fillStyle = cssVar("--bg", "#0b0e11");
        mctx.fillRect(0, 0, mw, mh);
        for (const n of nodes) {
          if (!visible.has(n.id)) continue;
          mctx.beginPath();
          mctx.arc(ox + (n.x ?? 0) * scale, oy + (n.y ?? 0) * scale, 1.6, 0, Math.PI * 2);
          mctx.fillStyle = kindColor(n.kind);
          mctx.fill();
        }
        // viewport rect
        const worldX0 = -cam.vx / cam.zoom;
        const worldY0 = -cam.vy / cam.zoom;
        const worldX1 = (W - cam.vx) / cam.zoom;
        const worldY1 = (H - cam.vy) / cam.zoom;
        mctx.strokeStyle = cssVar("--accent", "#5ec4b6");
        mctx.lineWidth = 1;
        mctx.strokeRect(
          ox + worldX0 * scale,
          oy + worldY0 * scale,
          (worldX1 - worldX0) * scale,
          (worldY1 - worldY0) * scale,
        );
        (mini as HTMLCanvasElement & { __mm?: { ox: number; oy: number; scale: number } }).__mm = {
          ox,
          oy,
          scale,
        };
      }
    }
  }, [
    tick,
    zoom,
    vx,
    vy,
    focus,
    depth,
    kinds,
    attention,
    labels,
    collapsed,
    pathTo,
    pathIds,
    focusedBranch,
    anim,
    alwaysShowDetails,
  ]);

  const hitTest = useCallback((clientX: number, clientY: number): SimNode | null => {
    const wrap = wrapRef.current;
    if (!wrap) return null;
    const rect = wrap.getBoundingClientRect();
    const cam = cameraRef.current;
    const wx = (clientX - rect.left - cam.vx) / cam.zoom;
    const wy = (clientY - rect.top - cam.vy) / cam.zoom;
    const path = pathIds ? new Set(pathIds) : null;
    const candidates = nodesRef.current.filter((n) => nodeIsVisible(n, focusedBranch, path));
    const tree = quadtree<SimNode>()
      .x((d) => d.x ?? 0)
      .y((d) => d.y ?? 0)
      .addAll(candidates);
    let bestBright: SimNode | null = null;
    let bestBrightD = Infinity;
    let bestGhost: SimNode | null = null;
    let bestGhostD = Infinity;
    tree.visit((node, x0, y0, x1, y1) => {
      if (!node.length) {
        let leaf: typeof node | undefined = node;
        while (leaf) {
          const d = leaf.data;
          const dx = (d.x ?? 0) - wx;
          const dy = (d.y ?? 0) - wy;
          const dist = Math.hypot(dx, dy);
          const bright = nodeIsBright(d, focusedBranch, path);
          const hitR = (bright ? d.r : Math.max(2.2, d.r * 0.55)) + 4 / cam.zoom;
          if (dist <= hitR) {
            if (bright && dist < bestBrightD) {
              bestBright = d;
              bestBrightD = dist;
            } else if (!bright && dist < bestGhostD) {
              bestGhost = d;
              bestGhostD = dist;
            }
          }
          leaf = leaf.next;
        }
        return;
      }
      return x0 > wx + 20 || x1 < wx - 20 || y0 > wy + 20 || y1 < wy - 20;
    });
    return bestBright ?? bestGhost;
  }, [nodeIsVisible, nodeIsBright, focusedBranch, pathIds]);

  const onPointerDown = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    const hit = hitTest(e.clientX, e.clientY);
    if (hit) {
      dragRef.current = { id: hit.id, sx: e.clientX, sy: e.clientY, moved: false };
      hit.fx = hit.x;
      hit.fy = hit.y;
      simRef.current?.alphaTarget(0.25).restart();
      return;
    }
    panRef.current = { sx: e.clientX, sy: e.clientY, vx, vy };
    setAnim(false);
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    if (dragRef.current) {
      const d = dragRef.current;
      const n = byIdRef.current.get(d.id);
      if (!n) return;
      if (Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) > 4) d.moved = true;
      if (d.moved) {
        const cam = cameraRef.current;
        n.fx = (e.clientX - rect.left - cam.vx) / cam.zoom;
        n.fy = (e.clientY - rect.top - cam.vy) / cam.zoom;
        n.x = n.fx;
        n.y = n.fy;
        setTick((t) => t + 1);
      }
      return;
    }
    if (panRef.current) {
      const p = panRef.current;
      setVx(p.vx + (e.clientX - p.sx));
      setVy(p.vy + (e.clientY - p.sy));
      return;
    }
    const hit = hitTest(e.clientX, e.clientY);
    if (hit) {
      setHover({ id: hit.id, sx: e.clientX - rect.left + 12, sy: e.clientY - rect.top + 12 });
    } else {
      setHover(null);
    }
  };

  const onPointerUp = () => {
    if (dragRef.current) {
      const d = dragRef.current;
      const n = byIdRef.current.get(d.id);
      if (n) {
        n.fx = null;
        n.fy = null;
      }
      if (d.moved) {
        suppressClick.current = true;
        simRef.current?.alpha(0.4).restart();
        writeLayout(nodesRef.current);
      } else {
        if (pathMode && focus && d.id !== focus) {
          setPathTo(d.id);
          setPathMode(false);
        } else {
          focusOn(d.id, false);
        }
      }
      dragRef.current = null;
      return;
    }
    panRef.current = null;
  };

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const wrap = wrapRef.current;
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const wx = (mx - vx) / zoom;
    const wy = (my - vy) / zoom;
    const nz = Math.max(0.3, Math.min(3, zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
    setZoom(nz);
    setVx(mx - wx * nz);
    setVy(my - wy * nz);
    setAnim(false);
  };

  const zoomBy = (f: number) => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const cx = wrap.clientWidth / 2;
    const cy = wrap.clientHeight / 2;
    const wx = (cx - vx) / zoom;
    const wy = (cy - vy) / zoom;
    const nz = Math.max(0.3, Math.min(3, zoom * f));
    setZoom(nz);
    setVx(cx - wx * nz);
    setVy(cy - wy * nz);
    setAnim(true);
    window.setTimeout(() => setAnim(false), 650);
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    const step = 40;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      setVx((v) => v + step);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      setVx((v) => v - step);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setVy((v) => v + step);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setVy((v) => v - step);
    } else if (e.key === "+" || e.key === "=") {
      e.preventDefault();
      zoomBy(1.2);
    } else if (e.key === "-" || e.key === "_") {
      e.preventDefault();
      zoomBy(1 / 1.2);
    } else if (e.key === "Escape") {
      setFocus(null);
      setPathTo(null);
      setPathMode(false);
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.delete("focus");
          return next;
        },
        { replace: true },
      );
    } else if (e.key === "Enter" && focus) {
      const n = byIdRef.current.get(focus);
      if (!n) return;
      const href = openNodeHref(n, projectByKn);
      if (href) openNodeFromGraph(href);
    }
  };

  const [indexHits, setIndexHits] = useState<KnowledgeGraphNode[]>([]);

  useEffect(() => {
    const needle = q.trim();
    if (!needle) {
      setIndexHits([]);
      return;
    }
    let cancelled = false;
    const t = window.setTimeout(() => {
      void searchKnowledgeIndex(needle, 24)
        .then((res) => {
          if (cancelled) return;
          setIndexHits(
            res.results.map((r) => ({
              id: r.id,
              kind: r.kind as KnowledgeGraphNode["kind"],
              name: r.name,
              status: (r.status as KnowledgeStatus) || "unreviewed",
              why: [],
              collection: "unsorted",
              note: r.note,
              inputs: [],
              outputs: [],
              updatedAt: "",
            })),
          );
        })
        .catch(() => {
          if (!cancelled) setIndexHits([]);
        });
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [q]);

  const searchHits = useMemo(() => {
    const byId = new Map<string, KnowledgeGraphNode>();
    if (graph && q.trim()) {
      const needle = q.trim().toLowerCase();
      for (const n of graph.nodes) {
        if (
          n.name.toLowerCase().includes(needle) ||
          n.id.toLowerCase().includes(needle) ||
          (n.note ?? "").toLowerCase().includes(needle) ||
          n.collection.toLowerCase().includes(needle)
        ) {
          byId.set(n.id, n);
        }
      }
    }
    for (const n of indexHits) if (!byId.has(n.id)) byId.set(n.id, n);
    return [...byId.values()].slice(0, 16);
  }, [graph, q, indexHits]);

  const kindCounts = useMemo(() => {
    const c: Record<KindKey, number> = { source: 0, fact: 0, knowledge: 0, project: 0 };
    if (!graph) return c;
    for (const n of graph.nodes) c[n.kind] += 1;
    return c;
  }, [graph]);

  const focusNode = focus ? byIdRef.current.get(focus) : null;
  const hoverNode = hover ? byIdRef.current.get(hover.id) : null;

  const panelList = useMemo(() => {
    if (!graph) return [];
    if (!focus || !focusedBranch) {
      return graph.nodes
        .filter((n) => (n.kind === "knowledge" || n.kind === "project") && n.inTree !== false)
        .slice(0, 80);
    }
    return graph.nodes.filter((n) => focusedBranch.has(n.id) && nodeIsBright(n, focusedBranch, pathIds ? new Set(pathIds) : null));
  }, [focus, focusedBranch, graph, nodeIsBright, pathIds]);

  const builtOn = useMemo(() => {
    if (!focusNode) return [];
    return focusNode.inputs
      .map((id) => byIdRef.current.get(id) ?? graph?.nodes.find((n) => n.id === id))
      .filter((n): n is KnowledgeGraphNode => Boolean(n));
  }, [focusNode, graph, tick]);

  const usedBy = useMemo(() => {
    if (!focusNode) return [];
    return focusNode.outputs
      .map((id) => byIdRef.current.get(id) ?? graph?.nodes.find((n) => n.id === id))
      .filter((n): n is KnowledgeGraphNode => Boolean(n));
  }, [focusNode, graph, tick]);

  const clearFocus = useCallback(() => {
    setFocus(null);
    setPathTo(null);
    setPathMode(false);
    setRevealPatch(null);
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("focus");
        return next;
      },
      { replace: true },
    );
  }, [setParams]);

  const jumpToSearchHit = useCallback(
    (n: KnowledgeGraphNode) => {
      setQ("");
      void getKnowledgeNeighborhood(n.id, 2).then((patch) => {
        setRevealPatch(patch);
        window.setTimeout(() => focusOn(n.id, true), 50);
      });
    },
    [focusOn],
  );

  return (
    <div className="app-shell knowledge-shell">
      <header className="topbar">
        <div className="brand">
          <Link to="/" className="brand-home-link" title="Back to projects">
            <img className="brand-logo" src="/logo.png" alt="OpenLeaf logo" />
            <span className="brand-mark">OpenLeaf</span>
          </Link>
          <span className="brand-sub">knowledge</span>
        </div>
        <nav className="topbar-nav" aria-label="Primary">
          <Link to="/" className="btn btn-quiet">
            Projects
          </Link>
          <Link to="/library" className="btn btn-quiet">
            Library
          </Link>
          <Link to="/facts" className="btn btn-quiet">
            Facts
          </Link>
          <Link to="/knowledge" className="btn btn-quiet is-active" aria-current="page">
            Knowledge
          </Link>
          <Link to="/review" className="btn btn-quiet">
            Review
            {inboxCount > 0 ? <span className="nav-badge">{inboxCount}</span> : null}
          </Link>
          {lastProject ? (
            <Link to={`/p/${encodeURIComponent(lastProject.id)}`} className="btn btn-quiet topbar-wide-only">
              {lastProject.name}
            </Link>
          ) : null}
        </nav>
        <div className="topbar-end">
          {remoteHost && (
            <button
              type="button"
              className="btn btn-ghost btn-quiet"
              onClick={() => {
                void hostLogout().finally(() => void refresh());
              }}
            >
              Sign out
            </button>
          )}
          <ThemePicker compact />
        </div>
      </header>

      {error ? <ErrorBanner onDismiss={() => setError(null)}>{error}</ErrorBanner> : null}

      <div
        className={`knowledge-main${panelCollapsed ? " is-panel-collapsed" : ""}`}
        ref={mainRef}
      >
        <div
          className={`knowledge-canvas-wrap${loading && !graph ? " is-loading" : ""}`}
          ref={wrapRef}
          tabIndex={0}
          onKeyDown={onKeyDown}
          aria-label="Knowledge graph canvas"
          aria-busy={loading && !graph}
        >
          {loading && !graph ? (
            <div className="knowledge-loading" role="status" aria-live="polite">
              <div className="knowledge-loading-orb" aria-hidden />
              <div className="knowledge-loading-copy">
                <strong>Loading knowledge</strong>
                <p>Click any item to see what it rests on.</p>
              </div>
            </div>
          ) : null}

          <div className="knowledge-toolbar">
            <div className="knowledge-toolbar-group knowledge-toolbar-search">
              <input
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search knowledge…"
                aria-label="Search knowledge graph"
              />
              {q.trim() ? (
                <ul className="knowledge-search-pop" role="listbox" aria-label="Search results">
                  {searchHits.map((n) => (
                    <li key={n.id}>
                      <button type="button" onClick={() => jumpToSearchHit(n)}>
                        <span className="knowledge-kind-dot" data-kind={n.kind} />
                        <span className="knowledge-search-pop-name">{displayLabel(n)}</span>
                        <span className="knowledge-search-pop-kind">{n.kind}</span>
                      </button>
                    </li>
                  ))}
                  {searchHits.length === 0 ? (
                    <li className="knowledge-search-pop-empty">No matches</li>
                  ) : null}
                </ul>
              ) : null}
            </div>
            <div className="knowledge-toolbar-group">
              <button type="button" className="btn btn-quiet" aria-label="Zoom out" onClick={() => zoomBy(0.8)}>
                −
              </button>
              <button type="button" className="btn btn-quiet" aria-label="Zoom in" onClick={() => zoomBy(1.25)}>
                +
              </button>
              <button
                type="button"
                className="btn btn-quiet"
                onClick={() => {
                  if (focus && focusedBranch) {
                    fitTo(
                      visibleNodes().filter((n) => focusedBranch.has(n.id)),
                      true,
                    );
                    return;
                  }
                  fitTo(visibleNodes(), true);
                }}
              >
                Fit
              </button>
              <div className="knowledge-more">
                <button
                  type="button"
                  className={`btn btn-quiet${moreOpen ? " is-active" : ""}`}
                  aria-expanded={moreOpen}
                  aria-haspopup="menu"
                  onClick={() => setMoreOpen((v) => !v)}
                >
                  More
                </button>
                {moreOpen ? (
                  <div className="knowledge-more-menu" role="menu">
                    <label role="menuitem">
                      Depth
                      <select
                        value={depth}
                        onChange={(e) => setDepth(e.target.value as "1" | "2" | "all")}
                        aria-label="Focus depth"
                      >
                        <option value="1">1 step</option>
                        <option value="2">2 steps</option>
                        <option value="all">All</option>
                      </select>
                    </label>
                    <label role="menuitem">
                      Labels
                      <select
                        value={labels}
                        onChange={(e) => setLabels(e.target.value as "auto" | "all" | "off")}
                      >
                        <option value="auto">Auto</option>
                        <option value="all">All</option>
                        <option value="off">Off</option>
                      </select>
                    </label>
                    <button
                      type="button"
                      role="menuitem"
                      className={attention ? "is-active" : undefined}
                      onClick={() => setAttention((v) => !v)}
                    >
                      {attention ? "Showing needs attention" : "Needs attention only"}
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className={alwaysShowDetails ? "is-active" : undefined}
                      onClick={() => setAlwaysShowDetails((v) => !v)}
                    >
                      {alwaysShowDetails ? "Hide uncited facts" : "Show all facts"}
                      {revealing ? "…" : ""}
                    </button>
                    {(Object.keys(kinds) as KindKey[]).map((k) => (
                      <label key={k} role="menuitemcheckbox" aria-checked={kinds[k]}>
                        <input
                          type="checkbox"
                          checked={kinds[k]}
                          onChange={() => setKinds((prev) => ({ ...prev, [k]: !prev[k] }))}
                        />
                        <span className="knowledge-kind-dot" data-kind={k} />
                        {kindLabel(k)}
                        <span className="review-count">{kindCounts[k]}</span>
                      </label>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          </div>

          {pathMode ? (
            <p className="knowledge-path-banner" role="status">
              Click another node to show the path
              <button
                type="button"
                className="btn btn-quiet"
                onClick={() => {
                  setPathMode(false);
                  setPathTo(null);
                }}
              >
                Cancel
              </button>
            </p>
          ) : null}

          <canvas
            ref={canvasRef}
            className={`knowledge-canvas${panRef.current ? " is-panning" : ""}`}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onWheel={onWheel}
            onDoubleClick={() => fitTo(visibleNodes(), true)}
          />

          {graph && graph.nodes.length > 12 ? (
            <canvas
              ref={miniRef}
              className="knowledge-minimap"
              aria-label="Minimap"
              onClick={(e) => {
                const mini = miniRef.current;
                const wrap = wrapRef.current;
                if (!mini || !wrap) return;
                const mm = (mini as HTMLCanvasElement & { __mm?: { ox: number; oy: number; scale: number } }).__mm;
                if (!mm) return;
                const rect = mini.getBoundingClientRect();
                const wx = (e.clientX - rect.left - mm.ox) / mm.scale;
                const wy = (e.clientY - rect.top - mm.oy) / mm.scale;
                centerOn(wx, wy, zoom);
              }}
            />
          ) : null}

          {hoverNode && hover ? (
            <div className="knowledge-hover-card" style={{ left: hover.sx, top: hover.sy }}>
              <div className="kh-kind">
                <span className="knowledge-kind-dot" data-kind={hoverNode.kind} />
                {kindLabel(hoverNode.kind)}
              </div>
              <div className="kh-name">{displayLabel(hoverNode, 56)}</div>
            </div>
          ) : null}

          <p className="knowledge-hint">Click a node · Esc clears</p>
        </div>

        {!panelCollapsed ? (
          <div
            className={`split-handle knowledge-panel-handle${panelDragging ? " active" : ""}`}
            onPointerDown={(e) => {
              e.preventDefault();
              setPanelDragging(true);
            }}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize knowledge panel"
            aria-valuenow={panelWidth}
          />
        ) : null}
        <aside
          className={`knowledge-panel${panelCollapsed ? " is-collapsed" : ""}`}
          aria-label="Knowledge panel"
          style={panelCollapsed ? undefined : { flex: `0 0 ${panelWidth}px`, width: panelWidth }}
        >
          {panelCollapsed ? (
            <button
              type="button"
              className="btn btn-ghost knowledge-panel-expand"
              onClick={togglePanelCollapsed}
              title="Show knowledge panel"
              aria-label="Show knowledge panel"
              aria-expanded={false}
            >
              Panel
            </button>
          ) : focusNode ? (
            <>
              <div className="knowledge-panel-head">
                <button type="button" className="btn btn-quiet knowledge-panel-back" onClick={clearFocus}>
                  ← All
                </button>
                <span className="knowledge-kind-dot" data-kind={focusNode.kind} />
                <span className={`knowledge-status-chip${statusNeedsAttention(focusNode.status) ? " is-needs" : ""}`}>
                  {statusLabel(focusNode.status)}
                </span>
                <button
                  type="button"
                  className="btn btn-ghost btn-icon knowledge-panel-collapse toolbar-wide-only"
                  onClick={togglePanelCollapsed}
                  title="Hide knowledge panel"
                  aria-label="Hide knowledge panel"
                  aria-expanded
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                    <path d="M15 6l-6 6 6 6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              </div>
              <h2>{displayLabel(focusNode, 72)}</h2>
              <p className="knowledge-panel-lede">
                {kindLabel(focusNode.kind)}
                {focusNode.collection && focusNode.collection !== "unsorted" && focusNode.collection !== "papers"
                  ? ` · ${focusNode.collection.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}`
                  : ""}
                {revealing ? " · updating…" : ""}
              </p>
              <div className="knowledge-panel-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => {
                    const href = openNodeHref(focusNode, projectByKn);
                    if (href) openNodeFromGraph(href);
                  }}
                >
                  {focusNode.kind === "project"
                    ? "Open paper"
                    : focusNode.kind === "knowledge"
                      ? "Review write-up"
                      : focusNode.kind === "fact"
                        ? "See source"
                        : "Open"}
                </button>
                <button
                  type="button"
                  className={`btn btn-quiet${pathMode ? " is-active" : ""}`}
                  onClick={() => {
                    setPathMode(true);
                    setPathTo(null);
                  }}
                >
                  Find path
                </button>
              </div>

              {focusNode.kind === "knowledge" ? (
                <div className="knowledge-panel-section">
                  <KnowledgeDependencyReview
                    nodeId={focusNode.id}
                    projectId={
                      focusNode.projectId ||
                      projectByKn.get(
                        focusNode.knowledgeId ||
                          (focusNode.id.startsWith("kn:") ? focusNode.id.slice(3) : focusNode.id),
                      )
                    }
                    compact
                  />
                </div>
              ) : null}

              {pathIds ? (
                <div className="knowledge-panel-section">
                  <h3>Path</h3>
                  <ol className="knowledge-panel-list">
                    {pathIds.map((id) => (
                      <li key={id}>
                        <button type="button" onClick={() => focusOn(id, true)}>
                          {(() => {
                            const node = byIdRef.current.get(id);
                            return node ? displayLabel(node) : id;
                          })()}
                        </button>
                      </li>
                    ))}
                  </ol>
                </div>
              ) : null}

              {focusNode.kind !== "knowledge" ? (
                <>
                  <div className="knowledge-panel-section">
                    <h3>Built on</h3>
                    {builtOn.length ? (
                      <ul className="knowledge-panel-list">
                        {builtOn.map((n) => (
                          <li key={n.id}>
                            <button type="button" onClick={() => focusOn(n.id, true)}>
                              <span className="knowledge-kind-dot" data-kind={n.kind} />
                              {displayLabel(n)}
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="knowledge-panel-empty">Nothing upstream</p>
                    )}
                  </div>

                  <div className="knowledge-panel-section">
                    <h3>Used by</h3>
                    {usedBy.length ? (
                      <ul className="knowledge-panel-list">
                        {usedBy.map((n) => (
                          <li key={n.id}>
                            <button type="button" onClick={() => focusOn(n.id, true)}>
                              <span className="knowledge-kind-dot" data-kind={n.kind} />
                              {displayLabel(n)}
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="knowledge-panel-empty">Nothing downstream</p>
                    )}
                  </div>
                </>
              ) : null}
            </>
          ) : (
            <>
              <div className="knowledge-panel-head">
                <h2>Knowledge</h2>
                <button
                  type="button"
                  className="btn btn-ghost btn-icon knowledge-panel-collapse toolbar-wide-only"
                  onClick={togglePanelCollapsed}
                  title="Hide knowledge panel"
                  aria-label="Hide knowledge panel"
                  aria-expanded
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                    <path d="M15 6l-6 6 6 6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              </div>
              <p className="knowledge-panel-lede">
                {graph
                  ? (() => {
                      const papers = panelList.filter((n) => n.kind === "project").length;
                      const kn = panelList.filter((n) => n.kind === "knowledge").length;
                      const parts = [];
                      if (kn) parts.push(`${kn} knowledge`);
                      if (papers) parts.push(`${papers} paper${papers === 1 ? "" : "s"}`);
                      return `${parts.join(" · ") || "Nothing yet"} · click to explore`;
                    })()
                  : "Loading…"}
              </p>
              <ul className="knowledge-panel-list" aria-label="Knowledge and papers">
                {panelList.map((n) => (
                  <li key={n.id}>
                    <button
                      type="button"
                      className={`knowledge-panel-row${focus === n.id ? " is-active" : ""}${n.kind === "project" ? " is-paper" : " is-knowledge"}`}
                      onClick={() => focusOn(n.id, true)}
                    >
                      <span className="knowledge-kind-dot" data-kind={n.kind} />
                      <span className="knowledge-panel-item-copy">
                        <span className="knowledge-panel-item-name">{displayLabel(n)}</span>
                        <span className="knowledge-panel-item-kind">{kindLabel(n.kind)}</span>
                      </span>
                      {statusNeedsAttention(n.status) ? (
                        <span className="knowledge-status-chip is-needs">Needs review</span>
                      ) : null}
                    </button>
                  </li>
                ))}
                {!panelList.length && graph ? (
                  <li className="knowledge-panel-empty">No knowledge or papers yet</li>
                ) : null}
              </ul>
            </>
          )}
        </aside>
      </div>

      <nav className={`phone-tabbar${lastProject ? " has-project" : ""} has-knowledge`} aria-label="Primary">
        <Link to="/">Projects</Link>
        {lastProject ? (
          <Link to={`/p/${encodeURIComponent(lastProject.id)}`} className="phone-tabbar-project">
            <span>{lastProject.name}</span>
          </Link>
        ) : null}
        <Link to="/library">Library</Link>
        <Link to="/facts">Facts</Link>
        <Link to="/knowledge" aria-current="page">
          Knowledge
        </Link>
        <Link to="/review">Review</Link>
      </nav>
    </div>
  );
}
