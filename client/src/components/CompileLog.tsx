import type { TexIssue } from "../api/types";

type Props = {
  log: string;
  open: boolean;
  onToggle: () => void;
  height: number;
  className?: string;
  issues?: TexIssue[];
  onJump?: (issue: TexIssue) => void;
};

export function CompileLog({ log, open, onToggle, height, className, issues = [], onJump }: Props) {
  const errors = issues.filter((issue) => issue.severity === "error").length;
  const warnings = issues.filter((issue) => issue.severity === "warning").length;
  const badge =
    errors > 0 ? `${errors} error${errors === 1 ? "" : "s"}` : warnings > 0 ? `${warnings} warning${warnings === 1 ? "" : "s"}` : "";
  return (
    <div className={`compile-log${className ? ` ${className}` : ""}`} style={{ height: open ? height : 36, flex: "0 0 auto" }}>
      <div className="compile-log-bar">
        <span>Compile log{badge ? ` · ${badge}` : ""}</span>
        <button type="button" className="btn btn-ghost" style={{ color: "#d7e0ea", borderColor: "#2a3644" }} onClick={onToggle}>
          {open ? "Hide" : "Show"}
        </button>
      </div>
      {open && issues.length > 0 && (
        <ul className="compile-issues">
          {issues.map((issue, index) => (
            <li key={`${issue.severity}-${issue.line ?? "x"}-${index}`}>
              <button type="button" className={`compile-issue is-${issue.severity}`} onClick={() => onJump?.(issue)}>
                <strong>{issue.severity}</strong>
                {issue.file ? ` ${issue.file}` : ""}
                {issue.line ? `:${issue.line}` : ""} — {issue.message}
              </button>
            </li>
          ))}
        </ul>
      )}
      {open && <pre>{log || "No compile output yet."}</pre>}
    </div>
  );
}
