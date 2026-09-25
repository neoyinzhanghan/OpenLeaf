import path from "node:path";

export const INSTANCE_MARKER = "--openleaf-instance=";

export function systemRoot(): string {
  return process.env.SystemRoot || "C:\\Windows";
}

export function powershellExe(): string {
  return path.win32.join(systemRoot(), "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

export function whereExe(): string {
  return path.win32.join(systemRoot(), "System32", "where.exe");
}

export function taskkillExe(): string {
  return path.win32.join(systemRoot(), "System32", "taskkill.exe");
}

export function commandLineHasInstance(line: string | null | undefined, instanceId: string): boolean {
  if (!line || !instanceId) return false;
  return line.includes(`${INSTANCE_MARKER}${instanceId}`);
}

/** How to read another process's command line. Linux uses /proc instead. */
export function commandLineProbe(
  pid: number,
  platform = process.platform,
): { file: string; args: string[] } | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (platform === "darwin") {
    return { file: "/bin/ps", args: ["-ww", "-p", String(pid), "-o", "command="] };
  }
  if (platform === "win32") {
    const script = [
      "$ProgressPreference='SilentlyContinue'",
      `$proc = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"`,
      "if ($null -eq $proc -or [string]::IsNullOrEmpty($proc.CommandLine)) { exit 1 }",
      "[Console]::Out.Write($proc.CommandLine)",
    ].join("; ");
    return {
      file: powershellExe(),
      args: ["-NoProfile", "-NonInteractive", "-Command", script],
    };
  }
  return null;
}

export function toolLookup(bin: string, platform = process.platform): { file: string; args: string[] } {
  if (platform === "win32") return { file: whereExe(), args: [bin] };
  if (platform === "darwin") return { file: "/usr/bin/which", args: [bin] };
  return { file: "/usr/bin/which", args: [bin] };
}

export function npmBuildCommand(platform = process.platform): { command: string; args: string[]; shell: boolean } {
  if (platform === "win32") return { command: "npm", args: ["run", "build"], shell: true };
  return { command: "npm", args: ["run", "build"], shell: false };
}

export function browserLauncher(
  url: string,
  platform = process.platform,
): { file: string; args: string[] } | null {
  if (!/^https?:\/\/\S+$/.test(url)) return null;
  if (platform === "darwin") return { file: "/usr/bin/open", args: [url] };
  if (platform === "win32") {
    const script = `Start-Process -FilePath '${url.replaceAll("'", "")}'`;
    return {
      file: powershellExe(),
      args: ["-NoProfile", "-NonInteractive", "-Command", script],
    };
  }
  return { file: "xdg-open", args: [url] };
}

export function terminateCommand(
  pid: number,
  force: boolean,
  platform = process.platform,
): { file: string; args: string[] } | { signal: NodeJS.Signals; group: true } {
  if (platform === "win32") {
    return {
      file: taskkillExe(),
      args: ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])],
    };
  }
  return { signal: force ? "SIGKILL" : "SIGTERM", group: true };
}
