type Props = {
  log: string;
  open: boolean;
  onToggle: () => void;
  height: number;
};

export function CompileLog({ log, open, onToggle, height }: Props) {
  return (
    <div className="compile-log" style={{ height: open ? height : 36, flex: "0 0 auto" }}>
      <div className="compile-log-bar">
        <span>Compile log</span>
        <button type="button" className="btn btn-ghost" style={{ color: "#d7e0ea", borderColor: "#2a3644" }} onClick={onToggle}>
          {open ? "Hide" : "Show"}
        </button>
      </div>
      {open && <pre>{log || "No compile output yet."}</pre>}
    </div>
  );
}
