import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import type { BranchLeafStat } from "../api/client";
import type { TimelineBranch, TimelineNode, TimelineView } from "../api/types";
import {
  formatTickTime,
  layoutTimeline,
  shortMsg,
  threadPathInset,
  type TimelineLayoutNode,
} from "./timelineLayout";

type Props = {
  view: TimelineView | null;
  loading?: boolean;
  compact?: boolean;
  busy?: boolean;
  /** Currently active / selected leaf id. */
  selectedId?: string | null;
  /** Hover highlight id (viewer). */
  hotId?: string | null;
  leafByBranch?: Map<string, BranchLeafStat>;
  className?: string;
  emptyLabel?: string;
  onNodeClick: (node: TimelineNode, branch: TimelineBranch, layout: TimelineLayoutNode) => void;
  /** When set, orbs emit hover enter/leave (viewer). Omit for click-only pickers. */
  onHoverIdChange?: (id: string | null) => void;
  /** Overlay inside the surface (e.g. hover dock). */
  children?: ReactNode;
  /** Recenter when this bumps (e.g. after load). */
  recenterToken?: number | string;
};

export function TimelineGraph({
  view,
  loading = false,
  compact = false,
  busy = false,
  selectedId = null,
  hotId = null,
  leafByBranch,
  className = "",
  emptyLabel = "No leaves yet — Commit to light the first thread.",
  onNodeClick,
  onHoverIdChange,
  children,
  recenterToken,
}: Props) {
  const uid = useId().replace(/:/g, "");
  const gradId = `tl-sacred-grad-${uid}`;
  const glowId = `tl-glow-${uid}`;
  const mergeArrowId = `tl-merge-arrow-${uid}`;

  const surfaceRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const panRef = useRef({ x: 36, y: 24 });
  const hoverClearRef = useRef<number | null>(null);
  const [pan, setPan] = useState({ x: 36, y: 24 });
  panRef.current = pan;

  const layout = useMemo(
    () =>
      view
        ? layoutTimeline(view, { compact })
        : {
            nodes: [] as TimelineLayoutNode[],
            edges: [],
            width: compact ? 480 : 640,
            height: compact ? 260 : 400,
            originY: compact ? 118 : 200,
            padLeft: compact ? 48 : 72,
          },
    [view, compact],
  );

  const recenter = useCallback(() => {
    const el = surfaceRef.current;
    if (!el) return;
    const y = Math.round(el.clientHeight / 2 - layout.originY);
    let x = 36;
    if (layout.nodes.length > 0) {
      const xs = layout.nodes.map((n) => n.x);
      const minX = Math.min(...xs);
      const maxX = Math.max(...xs);
      const pad = compact ? 28 : 48;
      const span = maxX - minX;
      // Prefer showing the whole chain when it fits; otherwise pin the tip in view
      // without shoving older leaves unnecessarily far off-screen.
      if (span + pad * 2 <= el.clientWidth) {
        x = Math.round((el.clientWidth - span) / 2 - minX);
      } else {
        const focus =
          layout.nodes.find((l) => l.node.id === selectedId) ??
          layout.nodes.find((l) => l.isHead && l.isSacred) ??
          layout.nodes[layout.nodes.length - 1];
        x = Math.round(el.clientWidth * (compact ? 0.78 : 0.72) - (focus?.x ?? maxX));
        const leftEdge = minX + x;
        if (leftEdge > pad) x = pad - minX;
      }
    }
    const next = { x, y };
    panRef.current = next;
    if (worldRef.current) {
      worldRef.current.style.transform = `translate(${next.x}px, ${next.y}px)`;
    }
    setPan(next);
  }, [layout, selectedId, compact]);

  useEffect(() => {
    if (loading && layout.nodes.length === 0) return;
    requestAnimationFrame(() => recenter());
  }, [recenterToken, layout.nodes.length, loading, recenter]);

  useEffect(() => {
    return () => {
      if (hoverClearRef.current != null) window.clearTimeout(hoverClearRef.current);
    };
  }, []);

  const keepHover = useCallback(
    (id: string) => {
      if (!onHoverIdChange) return;
      if (hoverClearRef.current != null) {
        window.clearTimeout(hoverClearRef.current);
        hoverClearRef.current = null;
      }
      onHoverIdChange(id);
    },
    [onHoverIdChange],
  );

  const clearHoverSoon = useCallback(() => {
    if (!onHoverIdChange) return;
    if (hoverClearRef.current != null) window.clearTimeout(hoverClearRef.current);
    // Long enough to travel from an orb to the bottom dock; never clear while the dock is in use.
    hoverClearRef.current = window.setTimeout(() => {
      const surface = surfaceRef.current;
      if (
        surface?.querySelector(".tl-hover-dock:hover, .tl-hover-dock:focus-within, .tl-orb:hover")
      ) {
        hoverClearRef.current = null;
        return;
      }
      onHoverIdChange(null);
      hoverClearRef.current = null;
    }, 400);
  }, [onHoverIdChange]);

  const applyPan = (next: { x: number; y: number }) => {
    panRef.current = next;
    if (worldRef.current) {
      worldRef.current.style.transform = `translate(${next.x}px, ${next.y}px)`;
    }
  };

  const onPointerDown = (e: ReactPointerEvent) => {
    if ((e.target as HTMLElement).closest(".tl-orb, .tl-hover-dock, .share-pick-prompt")) return;
    drag.current = { x: e.clientX, y: e.clientY, px: panRef.current.x, py: panRef.current.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    if (!drag.current) return;
    applyPan({
      x: drag.current.px + (e.clientX - drag.current.x),
      y: drag.current.py + (e.clientY - drag.current.y),
    });
  };
  const onPointerUp = () => {
    if (!drag.current) return;
    drag.current = null;
    setPan(panRef.current);
  };

  return (
    <div
      className={`timeline-surface${compact ? " is-compact" : ""}${className ? ` ${className}` : ""}`}
      ref={surfaceRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div className="timeline-aura" aria-hidden />
      <div
        className="timeline-world"
        ref={worldRef}
        style={{ transform: `translate(${pan.x}px, ${pan.y}px)`, width: layout.width, height: layout.height }}
      >
        <div className="tl-spine is-horizontal" style={{ top: layout.originY, width: layout.width }} aria-hidden />

        <svg className="timeline-edges" width={layout.width} height={layout.height}>
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="var(--tl-sacred)" stopOpacity="0.15" />
              <stop offset="40%" stopColor="var(--tl-sacred)" stopOpacity="0.95" />
              <stop offset="100%" stopColor="var(--tl-sacred)" stopOpacity="0.35" />
            </linearGradient>
            <filter id={glowId} x="-40%" y="-40%" width="180%" height="180%">
              <feGaussianBlur stdDeviation="2.2" result="b" />
              <feMerge>
                <feMergeNode in="b" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>

            <marker
              id={mergeArrowId}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
              markerUnits="strokeWidth"
            >
              <path d="M 0 1.2 L 9 5 L 0 8.8 Z" fill="currentColor" className="tl-merge-arrow-head" />
            </marker>
          </defs>
          {layout.edges.map((e) => {
            const short = Math.hypot(e.x2 - e.x1, e.y2 - e.y1) < 110;
            // Glow filters use the path bbox; flat same-lane strokes get a ~0
            // height box and the blur can eat the entire stroke — skip glow there.
            const glow = !e.merge && (e.sacred || (e.ai && e.fork)) && !short;
            return (
              <path
                key={e.id}
                d={threadPathInset(e, e.merge ? 11 : 9)}
                className={[
                  "tl-thread",
                  e.merge ? "is-merge" : "",
                  !e.merge && e.sacred ? "is-sacred" : "",
                  !e.merge && e.ai ? "is-ai" : "",
                  !e.merge && e.fork ? "is-fork" : "",
                  !e.merge && short ? "is-short" : "",
                  e.merge && e.ai ? "is-ai-merge" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                fill="none"
                markerEnd={e.merge ? `url(#${mergeArrowId})` : undefined}
                filter={glow ? `url(#${glowId})` : undefined}
              />
            );
          })}
        </svg>

        {layout.nodes.map((l) => {
          const selected = l.node.id === selectedId;
          const hot = l.node.id === hotId;
          const leaf = l.isHead ? leafByBranch?.get(l.branch.id) : undefined;
          const tickPad = 2 + l.tickTier * 18;
          const labelPad = 12 + l.labelTier * 26;
          return (
            <button
              key={l.node.id}
              type="button"
              className={[
                "tl-orb",
                l.isSacred ? "is-sacred" : l.isAi ? "is-ai" : "is-branch",
                l.isHead ? "is-head" : "",
                selected ? "is-selected" : "",
                l.node.legacy ? "is-legacy" : "",
                hot ? "is-hot" : "",
                leaf?.dirty ? "is-dirty" : "",
                l.tickAbove ? "tick-above" : "tick-below",
                l.labelAbove ? "label-above" : "label-below",
              ]
                .filter(Boolean)
                .join(" ")}
              style={
                {
                  left: l.x,
                  top: l.y,
                  ["--tl-tick-pad" as string]: `${tickPad}px`,
                  ["--tl-label-pad" as string]: `${labelPad}px`,
                } as CSSProperties
              }
              disabled={busy}
              aria-label={`${l.branch.name}: ${l.node.message}`}
              onMouseEnter={onHoverIdChange ? () => keepHover(l.node.id) : undefined}
              onMouseLeave={onHoverIdChange ? clearHoverSoon : undefined}
              onFocus={onHoverIdChange ? () => keepHover(l.node.id) : undefined}
              onBlur={onHoverIdChange ? clearHoverSoon : undefined}
              onClick={() => onNodeClick(l.node, l.branch, l)}
            >
              {(l.showTickStem || l.showTickTime) && (
                <span
                  className={`tl-tick${l.tickAbove ? " is-above" : " is-below"}${l.showTickTime ? "" : " is-stem"}`}
                  aria-hidden
                >
                  <span className="tl-tick-line" />
                  {l.showTickTime && (
                    <span className="tl-tick-time">{formatTickTime(l.node.createdAt)}</span>
                  )}
                </span>
              )}
              <span className="tl-orb-core" />
              <span className="tl-orb-ring" />
              {l.isHead && <span className="tl-orb-pulse" aria-hidden />}
              {l.showLabel && (
                <span
                  className={`tl-orb-label${l.isHead || l.labelMaxChars === 0 ? " is-chip" : " is-whisper"}${l.labelAbove ? " is-above" : " is-below"}`}
                >
                  {l.isHead || l.labelMaxChars === 0 ? (
                    <>
                      <span className="tl-orb-branch">{l.branch.name}</span>
                      {leaf?.dirty ? (
                        <span className="tl-orb-dirty-dot" title="Uncommitted changes" />
                      ) : null}
                    </>
                  ) : (
                    <span className="tl-orb-whisper">{shortMsg(l.node.message, l.labelMaxChars)}</span>
                  )}
                </span>
              )}
            </button>
          );
        })}

        {layout.nodes.length === 0 && !loading && (
          <div className="timeline-empty" style={{ left: layout.padLeft, top: layout.originY }}>
            {emptyLabel}
          </div>
        )}
        {loading && layout.nodes.length === 0 && (
          <div className="timeline-empty" style={{ left: layout.padLeft, top: layout.originY }}>
            Aligning the timeline…
          </div>
        )}
      </div>

      {children}
    </div>
  );
}

export type { TimelineLayoutNode };
