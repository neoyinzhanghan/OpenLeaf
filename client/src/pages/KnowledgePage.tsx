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
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  getKnowledgeGraph,
  getKnowledgeInbox,
  listKnowledgeItems,
  type KnowledgeGraph,
  type KnowledgeGraphNode,
  type KnowledgeStatus,
} from "../api/client";
import { hostLogout } from "../api/share";
import { ErrorBanner } from "../components/ErrorBanner";
import { ThemePicker } from "../components/ThemeToggle";
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
  if (kind === "project") return cssVar("--kind-project", "#6ba3e8");
  return cssVar("--kind-source", "#8a96a3");
}

function statusNeedsAttention(status: KnowledgeStatus): boolean {
  return status === "needs-review" || status === "unreviewed" || status === "flagged" || status === "rejected";
}

function nodeRadius(n: KnowledgeGraphNode): number {
  if (n.kind === "source") return 5;
  if (n.kind === "fact") return 6.5;
  if (n.kind === "project") return 13;
  return 8.5 + Math.min(6, (n.outputs?.length ?? 0) * 1.5);
}

function openNodeHref(node: KnowledgeGraphNode, projectByKn: Map<string, string>): string | null {
  if (node.kind === "knowledge") {
    const kn = node.id.startsWith("kn:") ? node.id.slice(3) : node.id;
    const projectId = projectByKn.get(kn);
    return projectId ? `/p/${encodeURIComponent(projectId)}` : null;
  }
  if (node.kind === "project") {
    const id = node.id.startsWith("proj:") ? node.id.slice(5) : node.id;
    return `/p/${encodeURIComponent(id)}`;
  }
  if (node.kind === "fact") {
    return `/facts?q=${encodeURIComponent(node.name)}`;
  }
  if (node.kind === "source") {
    const citekey = node.id.startsWith("src:") ? node.id.slice(4) : node.id;
    return `/library?paper=${encodeURIComponent(citekey)}`;
  }
  return null;
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
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [graph, setGraph] = useState<KnowledgeGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inboxCount, setInboxCount] = useState(0);
  const [lastProject, setLastProject] = useState<LastProject | null>(null);
  const [projectByKn, setProjectByKn] = useState<Map<string, string>>(() => new Map());

  const [zoom, setZoom] = useState(1);
  const [vx, setVx] = useState(0);
  const [vy, setVy] = useState(0);
  const [anim, setAnim] = useState(false);
  const [focus, setFocus] = useState<string | null>(params.get("focus"));
  const [depth, setDepth] = useState<"1" | "2" | "all">("all");
  const [kinds, setKinds] = useState<Record<KindKey, boolean>>({
    source: true,
    fact: true,
    knowledge: true,
    project: true,
  });
  const [attention, setAttention] = useState(false);
  const [labels, setLabels] = useState<"auto" | "all" | "off">("auto");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [q, setQ] = useState("");
  const [pathMode, setPathMode] = useState(false);
  const [pathTo, setPathTo] = useState<string | null>(null);
  const [trail, setTrail] = useState<string[]>([]);
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
  const cameraRef = useRef({ zoom, vx, vy, anim });
  const uiRef = useRef({ focus, depth, kinds, attention, labels, collapsed, pathTo });

  cameraRef.current = { zoom, vx, vy, anim };
  uiRef.current = { focus, depth, kinds, attention, labels, collapsed, pathTo };

  useEffect(() => {
    setLastProject(readLastProject());
  }, []);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([getKnowledgeGraph(), getKnowledgeInbox(), listKnowledgeItems()])
      .then(([g, inbox, items]) => {
        if (cancelled) return;
        setGraph(g);
        setInboxCount(inbox.groups.reduce((n, gr) => n + gr.items.length, 0));
        const map = new Map<string, string>();
        for (const it of items.items) map.set(it.knowledgeId, it.id);
        setProjectByKn(map);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load knowledge graph");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Build simulation when graph arrives
  useEffect(() => {
    if (!graph) return;
    const saved = readLayout();
    const colCenters = new Map<string, { x: number; y: number }>();
    graph.collections.forEach((c, i) => {
      const angle = (i / Math.max(1, graph.collections.length)) * Math.PI * 2;
      colCenters.set(c, { x: Math.cos(angle) * 280, y: Math.sin(angle) * 220 });
    });

    const nodes: SimNode[] = graph.nodes.map((n, i) => {
      const c = colCenters.get(n.collection) ?? { x: 0, y: 0 };
      const pos = saved[n.id];
      return {
        ...n,
        r: nodeRadius(n),
        x: pos?.x ?? c.x + (Math.sin(i * 12.9898) * 10000) % 120 - 60,
        y: pos?.y ?? c.y + (Math.cos(i * 78.233) * 10000) % 120 - 60,
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
      .force("center", forceCenter(0, 0).strength(0.04))
      .force(
        "x",
        forceX<SimNode>((d) => colCenters.get(d.collection)?.x ?? 0).strength(0.04),
      )
      .force(
        "y",
        forceY<SimNode>((d) => colCenters.get(d.collection)?.y ?? 0).strength(0.04),
      )
      .alpha(0.85)
      .alphaDecay(0.028);

    sim.on("tick", () => setTick((t) => t + 1));
    sim.on("end", () => writeLayout(nodesRef.current));
    simRef.current = sim;

    // Fit after first settle frames
    const t = window.setTimeout(() => {
      fitTo(nodes, false);
    }, 80);

    return () => {
      window.clearTimeout(t);
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

  const visibleNodes = useCallback(() => {
    return nodesRef.current.filter((n) => !collapsed[n.collection] && kinds[n.kind]);
  }, [collapsed, kinds]);

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
    const z = Math.max(0.35, Math.min(2.2, Math.min(W / (x1 - x0 + 220), H / (y1 - y0 + 180))));
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
      setTrail((t) => [id, ...t.filter((x) => x !== id)].slice(0, 8));
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set("focus", id);
          return next;
        },
        { replace: true },
      );
      if (center) centerOn(n.x ?? 0, n.y ?? 0, Math.max(cameraRef.current.zoom, 1.1));
    },
    [centerOn, setParams],
  );

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

    const visible = new Set(
      nodes
        .filter((n) => !ui.collapsed[n.collection] && ui.kinds[n.kind])
        .filter((n) => !ui.attention || statusNeedsAttention(n.status))
        .map((n) => n.id),
    );

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

    const lit = ui.focus ? focusedBranch : null;
    const pathSet = pathIds ? new Set(pathIds) : null;

    ctx.save();
    ctx.translate(cam.vx, cam.vy);
    ctx.scale(cam.zoom, cam.zoom);

    // Soft collection halos
    const byCol = new Map<string, SimNode[]>();
    for (const n of nodes) {
      if (ui.collapsed[n.collection] || !visible.has(n.id)) continue;
      const list = byCol.get(n.collection) ?? [];
      list.push(n);
      byCol.set(n.collection, list);
    }
    for (const [col, list] of byCol) {
      if (list.length < 2) continue;
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const n of list) {
        x0 = Math.min(x0, (n.x ?? 0) - n.r);
        y0 = Math.min(y0, (n.y ?? 0) - n.r);
        x1 = Math.max(x1, (n.x ?? 0) + n.r);
        y1 = Math.max(y1, (n.y ?? 0) + n.r);
      }
      const pad = 28;
      ctx.beginPath();
      ctx.setLineDash([4, 6]);
      ctx.strokeStyle = cssVar("--line-strong", "#2c3642");
      ctx.globalAlpha = 0.35;
      ctx.roundRect(x0 - pad, y0 - pad, x1 - x0 + pad * 2, y1 - y0 + pad * 2, 18);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = cssVar("--ink-faint", "#5f6b78");
      ctx.font = "600 10px var(--font), sans-serif";
      ctx.fillText(col.toUpperCase(), x0 - pad + 8, y0 - pad + 14);
      ctx.globalAlpha = 1;
    }

    // Edges
    for (const link of links) {
      const a = link.source as SimNode;
      const b = link.target as SimNode;
      const pa = nodePos(a.id);
      const pb = nodePos(b.id);
      if (!pa || !pb) continue;
      if (pa.bubble && pb.bubble && pa.bubble === pb.bubble) continue;
      const onPath = pathSet ? pathSet.has(a.id) && pathSet.has(b.id) : false;
      const inFocus = lit ? lit.has(a.id) && lit.has(b.id) : true;
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
        ctx.lineWidth = (inFocus ? 1.25 : 0.7) / cam.zoom;
        ctx.globalAlpha = lit ? (inFocus ? 0.75 : 0.12) : 0.35;
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
      const inFocus = lit ? lit.has(n.id) : true;
      const onPath = pathSet?.has(n.id);
      ctx.globalAlpha = lit ? (inFocus || onPath ? 1 : 0.18) : 1;

      if (n.status === "flagged" || onPath) {
        ctx.beginPath();
        ctx.arc(x, y, n.r + 4, 0, Math.PI * 2);
        ctx.strokeStyle = flagColor;
        ctx.lineWidth = 2 / cam.zoom;
        ctx.globalAlpha *= 0.85;
        ctx.stroke();
        ctx.globalAlpha = lit ? (inFocus || onPath ? 1 : 0.18) : 1;
      }

      ctx.beginPath();
      ctx.arc(x, y, n.r, 0, Math.PI * 2);
      const fill = kindColor(n.kind);
      if (n.status === "rejected") {
        ctx.fillStyle = rejectColor;
        ctx.globalAlpha *= 0.9;
        ctx.fill();
      } else if (checked(n.status)) {
        ctx.fillStyle = fill;
        ctx.fill();
      } else {
        ctx.fillStyle = cssVar("--bg-elevated", "#13181e");
        ctx.fill();
        ctx.strokeStyle = fill;
        ctx.lineWidth = 2 / cam.zoom;
        ctx.stroke();
      }

      const showLabel =
        ui.labels === "all" ||
        (ui.labels === "auto" &&
          (cam.zoom > 1.05 || n.kind === "project" || (lit && lit.has(n.id)) || focus === n.id));
      if (showLabel) {
        ctx.fillStyle = cssVar("--ink", "#eef2f6");
        ctx.font = `500 ${11 / cam.zoom}px var(--font), sans-serif`;
        ctx.globalAlpha = lit && !inFocus ? 0.25 : 0.9;
        ctx.fillText(n.name.slice(0, 42), x + n.r + 4, y + 3);
      }
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
  }, [tick, zoom, vx, vy, focus, depth, kinds, attention, labels, collapsed, pathTo, pathIds, focusedBranch, anim]);

  const hitTest = useCallback((clientX: number, clientY: number): SimNode | null => {
    const wrap = wrapRef.current;
    if (!wrap) return null;
    const rect = wrap.getBoundingClientRect();
    const cam = cameraRef.current;
    const wx = (clientX - rect.left - cam.vx) / cam.zoom;
    const wy = (clientY - rect.top - cam.vy) / cam.zoom;
    const ui = uiRef.current;
    const candidates = nodesRef.current.filter(
      (n) => !ui.collapsed[n.collection] && ui.kinds[n.kind] && (!ui.attention || statusNeedsAttention(n.status)),
    );
    const tree = quadtree<SimNode>()
      .x((d) => d.x ?? 0)
      .y((d) => d.y ?? 0)
      .addAll(candidates);
    let best: SimNode | null = null;
    let bestD = Infinity;
    tree.visit((node, x0, y0, x1, y1) => {
      if (!node.length) {
        let leaf: typeof node | undefined = node;
        while (leaf) {
          const d = leaf.data;
          const dx = (d.x ?? 0) - wx;
          const dy = (d.y ?? 0) - wy;
          const dist = Math.hypot(dx, dy);
          if (dist <= d.r + 4 / cam.zoom && dist < bestD) {
            best = d;
            bestD = dist;
          }
          leaf = leaf.next;
        }
        return;
      }
      return x0 > wx + 20 || x1 < wx - 20 || y0 > wy + 20 || y1 < wy - 20;
    });
    return best;
  }, []);

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
      if (href) navigate(href);
    }
  };

  const searchHits = useMemo(() => {
    if (!graph || !q.trim()) return [];
    const needle = q.trim().toLowerCase();
    return graph.nodes
      .filter(
        (n) =>
          n.name.toLowerCase().includes(needle) ||
          n.id.toLowerCase().includes(needle) ||
          (n.note ?? "").toLowerCase().includes(needle) ||
          n.collection.toLowerCase().includes(needle),
      )
      .slice(0, 12);
  }, [graph, q]);

  const kindCounts = useMemo(() => {
    const c: Record<KindKey, number> = { source: 0, fact: 0, knowledge: 0, project: 0 };
    if (!graph) return c;
    for (const n of graph.nodes) c[n.kind] += 1;
    return c;
  }, [graph]);

  const focusNode = focus ? byIdRef.current.get(focus) : null;
  const hoverNode = hover ? byIdRef.current.get(hover.id) : null;

  const collectionRows = useMemo(() => {
    if (!graph) return [];
    return graph.collections.map((name) => {
      const members = graph.nodes.filter((n) => n.collection === name);
      return {
        name,
        count: members.length,
        flagText: members.some((n) => statusNeedsAttention(n.status)) ? "needs attention" : "",
      };
    });
  }, [graph]);

  const panelList = useMemo(() => {
    if (!focus || !focusedBranch || !graph) return graph?.nodes.slice(0, 40) ?? [];
    return graph.nodes.filter((n) => focusedBranch.has(n.id));
  }, [focus, focusedBranch, graph]);

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

      <div className="knowledge-main">
        <div
          className="knowledge-canvas-wrap"
          ref={wrapRef}
          tabIndex={0}
          onKeyDown={onKeyDown}
          aria-label="Knowledge graph canvas"
        >
          <div className="knowledge-toolbar">
            <div className="knowledge-toolbar-group">
              <button type="button" className="btn btn-quiet" aria-label="Zoom out" onClick={() => zoomBy(0.8)}>
                −
              </button>
              <span className="knowledge-zoom-label">{Math.round(zoom * 100)}%</span>
              <button type="button" className="btn btn-quiet" aria-label="Zoom in" onClick={() => zoomBy(1.25)}>
                +
              </button>
              <button type="button" className="btn btn-quiet" onClick={() => fitTo(visibleNodes(), true)}>
                Fit all
              </button>
              <button
                type="button"
                className="btn btn-quiet"
                onClick={() => {
                  if (!focus || !focusedBranch) {
                    fitTo(visibleNodes(), true);
                    return;
                  }
                  fitTo(
                    visibleNodes().filter((n) => focusedBranch.has(n.id)),
                    true,
                  );
                }}
              >
                Fit branch
              </button>
            </div>
            <div className="knowledge-toolbar-group">
              <label>
                Depth{" "}
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
              <button
                type="button"
                className={`btn btn-quiet${pathMode ? " is-active" : ""}`}
                onClick={() => {
                  setPathMode(true);
                  setPathTo(null);
                }}
              >
                How does it connect…
              </button>
              {(pathMode || pathTo) && (
                <button
                  type="button"
                  className="btn btn-quiet"
                  onClick={() => {
                    setPathMode(false);
                    setPathTo(null);
                  }}
                >
                  Clear path
                </button>
              )}
              <button
                type="button"
                className={`btn btn-quiet${attention ? " is-active" : ""}`}
                onClick={() => setAttention((v) => !v)}
              >
                Needs attention
              </button>
              <button
                type="button"
                className="btn btn-quiet"
                onClick={() => {
                  setFocus(null);
                  setPathTo(null);
                  setPathMode(false);
                }}
              >
                Clear focus
              </button>
            </div>
            <div className="knowledge-toolbar-group">
              <input
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Find…"
                aria-label="Search knowledge graph"
              />
            </div>
          </div>

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

          {hoverNode && hover ? (
            <div className="knowledge-hover-card" style={{ left: hover.sx, top: hover.sy }}>
              <div className="kh-kind">
                <span className="knowledge-kind-dot" data-kind={hoverNode.kind} />
                {hoverNode.kind} · {hoverNode.collection}
              </div>
              <div className="kh-name">{hoverNode.name}</div>
              <div className="kh-meta">
                Status: {hoverNode.status}
                {hoverNode.why.length ? ` — ${hoverNode.why.join("; ")}` : ""}
                {hoverNode.note ? `\n${hoverNode.note}` : ""}
                <br />
                Built on {hoverNode.inputs.length} · used by {hoverNode.outputs.length}
              </div>
            </div>
          ) : null}

          <p className="knowledge-hint">Scroll to zoom · drag to pan · drag a node to move it · click to focus</p>
        </div>

        <aside className="knowledge-panel" aria-label="Knowledge panel">
          <h2>{focusNode ? focusNode.name : "Knowledge tree"}</h2>
          <p className="review-row-meta" style={{ margin: 0 }}>
            {graph
              ? `${graph.nodes.length} nodes · ${graph.edges.length} edges`
              : "Loading graph…"}
            {focusNode ? ` · ${focusNode.status}` : ""}
          </p>

          {focusNode ? (
            <div className="knowledge-panel-section">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  const href = openNodeHref(focusNode, projectByKn);
                  if (href) navigate(href);
                }}
              >
                Open
              </button>
            </div>
          ) : null}

          {pathIds ? (
            <div className="knowledge-panel-section">
              <h3>Path</h3>
              <ol className="knowledge-panel-list">
                {pathIds.map((id) => (
                  <li key={id}>
                    <button type="button" onClick={() => focusOn(id, true)}>
                      {byIdRef.current.get(id)?.name ?? id}
                    </button>
                  </li>
                ))}
              </ol>
            </div>
          ) : null}

          {q.trim() ? (
            <div className="knowledge-panel-section">
              <h3>Search</h3>
              <ul className="knowledge-search-hits">
                {searchHits.map((n) => (
                  <li key={n.id}>
                    <button type="button" onClick={() => focusOn(n.id, true)}>
                      <span className="knowledge-kind-dot" data-kind={n.kind} />
                      {n.name}
                    </button>
                  </li>
                ))}
                {searchHits.length === 0 ? <li className="review-row-meta" style={{ padding: "0.5rem" }}>No matches</li> : null}
              </ul>
            </div>
          ) : null}

          <div className="knowledge-panel-section">
            <h3>Show</h3>
            <div className="knowledge-filters">
              {(Object.keys(kinds) as KindKey[]).map((k) => (
                <label key={k}>
                  <input
                    type="checkbox"
                    checked={kinds[k]}
                    onChange={() => setKinds((prev) => ({ ...prev, [k]: !prev[k] }))}
                  />
                  <span className="knowledge-kind-dot" data-kind={k} />
                  {k} ({kindCounts[k]})
                </label>
              ))}
            </div>
            <div style={{ marginTop: "0.55rem" }}>
              <label>
                Labels{" "}
                <select value={labels} onChange={(e) => setLabels(e.target.value as "auto" | "all" | "off")}>
                  <option value="auto">Auto</option>
                  <option value="all">All</option>
                  <option value="off">Off</option>
                </select>
              </label>
            </div>
          </div>

          <div className="knowledge-panel-section">
            <h3>Collections</h3>
            <ul className="knowledge-panel-list">
              {collectionRows.map((c) => (
                <li key={c.name}>
                  <button
                    type="button"
                    onClick={() => {
                      const members = nodesRef.current.filter((n) => n.collection === c.name);
                      fitTo(members, true);
                    }}
                  >
                    {c.name} <span className="review-count">{c.count}</span>
                    {c.flagText ? ` · ${c.flagText}` : ""}
                  </button>
                  <button
                    type="button"
                    className="btn btn-quiet"
                    onClick={() => setCollapsed((prev) => ({ ...prev, [c.name]: !prev[c.name] }))}
                  >
                    {collapsed[c.name] ? "Expand" : "Collapse"}
                  </button>
                </li>
              ))}
            </ul>
          </div>

          {trail.length ? (
            <div className="knowledge-panel-section">
              <h3>Recently visited</h3>
              <div className="knowledge-trail">
                {trail.map((id) => (
                  <button key={id} type="button" onClick={() => focusOn(id, true)}>
                    {byIdRef.current.get(id)?.name ?? id}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <div className="knowledge-panel-section">
            <h3>{focus ? "Focused branch" : "Nodes"}</h3>
            <ul className="knowledge-panel-list" aria-label="Text alternative to the canvas">
              {panelList.map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    className={focus === n.id ? "is-active" : undefined}
                    onClick={() => focusOn(n.id, true)}
                  >
                    <span className="knowledge-kind-dot" data-kind={n.kind} />
                    {n.name}
                    <span className="review-count"> · {n.status}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
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
