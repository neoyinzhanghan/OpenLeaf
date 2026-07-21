import { useEffect, useRef, useState, type ReactNode } from "react";

type Props = {
  left: ReactNode;
  right: ReactNode;
  initialLeftRatio?: number;
  minLeft?: number;
  minRight?: number;
  storageKey?: string;
};

export function SplitPane({
  left,
  right,
  initialLeftRatio = 0.5,
  minLeft = 240,
  minRight = 240,
  storageKey,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [ratio, setRatio] = useState(() => {
    if (storageKey) {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        const n = Number(saved);
        if (!Number.isNaN(n) && n > 0.15 && n < 0.85) return n;
      }
    }
    return initialLeftRatio;
  });
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!dragging) return;

    const onMove = (e: MouseEvent) => {
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const clamped = Math.min(
        rect.width - minRight,
        Math.max(minLeft, x),
      );
      setRatio(clamped / rect.width);
    };

    const onUp = () => {
      setDragging(false);
      if (storageKey) localStorage.setItem(storageKey, String(ratio));
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [dragging, minLeft, minRight, ratio, storageKey]);

  useEffect(() => {
    if (!dragging && storageKey) {
      localStorage.setItem(storageKey, String(ratio));
    }
  }, [dragging, ratio, storageKey]);

  return (
    <div className="split-row" ref={containerRef}>
      <div className="pane" style={{ flex: `0 0 ${ratio * 100}%` }}>
        {left}
      </div>
      <div
        className={`split-handle${dragging ? " active" : ""}`}
        onMouseDown={() => setDragging(true)}
        role="separator"
        aria-orientation="vertical"
        aria-valuenow={Math.round(ratio * 100)}
      />
      <div className="pane" style={{ flex: "1 1 auto" }}>
        {right}
      </div>
    </div>
  );
}
