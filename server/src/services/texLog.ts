export type TexIssue = {
  severity: "error" | "warning" | "info";
  file: string | null;
  line: number | null;
  message: string;
};

function currentFile(stack: string[]): string | null {
  return stack.length ? stack[stack.length - 1]! : null;
}

/** Track `(./file` opens and `)` closes so errors can name the file TeX was reading. */
function scanFileStack(line: string, stack: string[]): void {
  for (let i = 0; i < line.length; i += 1) {
    if (line.startsWith("(./", i) || line.startsWith("(/", i)) {
      const start = line[i + 1] === "." ? i + 3 : i + 2;
      let j = start;
      while (j < line.length && line[j] !== ")" && line[j] !== " " && line[j] !== "\n") j += 1;
      const name = line.slice(start, j);
      if (name && !name.startsWith(".")) {
        stack.push(name.replace(/^\.\//, ""));
        i = j - 1;
      }
      continue;
    }
    if (line[i] === ")" && stack.length) stack.pop();
  }
}

function lineNumberNear(lines: string[], index: number): number | null {
  for (let j = index; j < Math.min(lines.length, index + 12); j += 1) {
    const m = /^l\.(\d+)\b/.exec(lines[j] ?? "");
    if (m) return Number(m[1]);
    const on = /on input line (\d+)/.exec(lines[j] ?? "");
    if (on) return Number(on[1]);
  }
  return null;
}

/**
 * Pull errors, warnings, and box messages out of a TeX / latexmk log.
 * Errors are lines that start with `! `. The line number is the following `l.<n>`.
 * `defaultFile` is used when TeX has not opened a file yet (errors in the main file).
 */
export function parseTexLog(log: string, opts?: { defaultFile?: string }): TexIssue[] {
  const lines = log.split(/\r?\n/);
  const stack: string[] = [];
  const issues: TexIssue[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    scanFileStack(line, stack);
    const file = currentFile(stack) ?? opts?.defaultFile ?? null;

    if (line.startsWith("! ")) {
      const message = line.slice(2).trim() || "TeX error";
      issues.push({
        severity: "error",
        file,
        line: lineNumberNear(lines, i + 1),
        message,
      });
      continue;
    }

    if (/^Overfull \\|^Underfull \\/.test(line)) {
      const box = /lines? (\d+)/.exec(line);
      issues.push({
        severity: "info",
        file,
        line: box ? Number(box[1]) : null,
        message: line.trim(),
      });
      continue;
    }

    const warning =
      /Warning:/.test(line) &&
      (/Citation|Reference|undefined|not found|rerun|There were undefined|File /i.test(line) ||
        /LaTeX Warning:|Package \w+ Warning:/.test(line));
    if (warning) {
      const on = /on input line (\d+)/.exec(line);
      let message = line.trim();
      const next = lines[i + 1];
      if (next && /^\s{2,}\S/.test(next) && !next.startsWith("!")) {
        message = `${message} ${next.trim()}`;
      }
      issues.push({
        severity: "warning",
        file,
        line: on ? Number(on[1]) : lineNumberNear(lines, i),
        message,
      });
    }
  }

  return dedupeIssues(issues);
}

function dedupeIssues(issues: TexIssue[]): TexIssue[] {
  const seen = new Set<string>();
  const unique: TexIssue[] = [];
  for (const issue of issues) {
    const key = `${issue.severity}\0${issue.file ?? ""}\0${issue.line ?? ""}\0${issue.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(issue);
  }
  return unique;
}

export function texErrorCount(issues: TexIssue[]): number {
  return issues.filter((issue) => issue.severity === "error").length;
}
