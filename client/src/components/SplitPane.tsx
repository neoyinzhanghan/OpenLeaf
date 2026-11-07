import { useEffect, useRef, useState, type ReactNode } from "react";

type Props = {
  left: ReactNode;
  right: ReactNode;
  initialLeftRatio?: number;
  minLeft?: number;
  minRight?: number;
  storageKey?: string;
  className?: string;
  leftClassName?: string;
  rightClassName?: string;
};

export function SplitPane({
  left,
  right,
  initialLeftRatio = 0.5,
  minLeft = 240,
  minRight = 240,
  storageKey,
  className,
  leftClassName,
  rightClassName,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const ratioRef = useRef(initialLeftRatio);
  const [ratio, setRatio] = useState(() => {
    if (storageKey) {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        const n = Number(saved);
        if (!Number.isNaN(n) && n > 0.15 && n < 0.85) {
          ratioRef.current = n;
          return n;
        }
      }
    }
    ratioRef.current = initialLeftRatio;
    return initialLeftRatio;
  });
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    ratioRef.current = ratio;
  }, [ratio]);

  useEffect(() => {
    if (!dragging) return;

    const onMove = (e: PointerEvent) => {
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const clamped = Math.min(rect.width - minRight, Math.max(minLeft, x));
      const next = clamped / rect.width;
      ratioRef.current = next;
      setRatio(next);
    };

    const onUp = () => {
      setDragging(false);
      if (storageKey) localStorage.setItem(storageKey, String(ratioRef.current));
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
  }, [dragging, minLeft, minRight, storageKey]);

  return (
    <div className={`split-row${className ? ` ${className}` : ""}`} ref={containerRef}>
      <div className={`pane${leftClassName ? ` ${leftClassName}` : ""}`} style={{ flex: `0 0 ${ratio * 100}%` }}>
        {left}
      </div>
      <div
        className={`split-handle${dragging ? " active" : ""}`}
        onPointerDown={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        role="separator"
        aria-orientation="vertical"
        aria-valuenow={Math.round(ratio * 100)}
      />
      <div className={`pane${rightClassName ? ` ${rightClassName}` : ""}`} style={{ flex: "1 1 auto" }}>
        {right}
      </div>
    </div>
  );
}
