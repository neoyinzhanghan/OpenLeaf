import fs from "node:fs";
import { CHECK_SCHEMA_VERSION, type CheckResult } from "./checks.js";
import { platformLabel } from "./deps.js";
import { logPath } from "./instance.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SECRET_LINE =
  /password|cookie|authorization|bearer|host-credentials|tunnel token|openleaf_host|invitation|secret/i;

/** Drop or mask values that look like credentials. Paths are removed. */
export function redactText(input: string): string {
  let text = input;
  const rules: Array<[RegExp, string]> = [
    [/password\s*[:=]?\s*\S+/gi, "password [redacted]"],
    [/\b[A-Za-z0-9_-]{6,}-[A-Za-z0-9_-]{6,}-[A-Za-z0-9_-]{4,}\b/g, "[redacted]"],
    [/OPENLEAF_HOST_PASSWORD=\S+/g, "OPENLEAF_HOST_PASSWORD=[redacted]"],
    [/OPENLEAF_HOST_TUNNEL_TOKEN=\S+/g, "OPENLEAF_HOST_TUNNEL_TOKEN=[redacted]"],
    [/Authorization:\s*Bearer\s+\S+/gi, "Authorization: Bearer [redacted]"],
    [/Bearer\s+[A-Za-z0-9_-]{8,}/g, "Bearer [redacted]"],
    [/openleaf_host=[^;\s]+/gi, "openleaf_host=[redacted]"],
    [/\/join\/[A-Za-z0-9_-]+/g, "/join/[redacted]"],
    [/\/(?:library-ai|lib-share|ai)\/[A-Za-z0-9_-]{8,}/g, "/[redacted]"],
    [/\b[A-Za-z0-9_-]{24,}\b/g, "[redacted]"],
    [/[A-Za-z]:\\(?:[^\\\s]+\\)+[^\\\s]+/g, "[path]"],
    [/\/(?:home|Users|tmp|var|opt|usr)\/[^\s]+/g, "[path]"],
  ];
  for (const [pattern, replacement] of rules) text = text.replace(pattern, replacement);
  return text
    .split(/\r?\n/)
    .filter((line) => !/host-credentials\.txt/.test(line) || !/Password/i.test(line))
    .join("\n");
}

export function readSanitizedLog(maxLines = 80, maxChars = 4000): string {
  let raw = "";
  try {
    raw = fs.readFileSync(logPath(), "utf8");
  } catch {
    return "";
  }
  const lines = raw.split(/\r?\n/).slice(-maxLines);
  const kept = lines.filter((line) => !SECRET_LINE.test(line) || /\[redacted\]/.test(redactText(line)));
  const cleaned = redactText(kept.join("\n")).slice(-maxChars);
  return cleaned;
}

function openleafVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(path.join(here, "../../package.json"), "utf8")) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

export type SupportReport = {
  schemaVersion: number;
  generatedAt: string;
  openleafVersion: string;
  node: string;
  platform: string;
  failingChecks: Array<Pick<CheckResult, "id" | "severity" | "status" | "summary" | "impact" | "action">>;
  logExcerpt: string;
  prompt: string;
};

export function buildSupportReport(checks: CheckResult[]): SupportReport {
  const failingChecks = checks
    .filter((check) => check.status === "fail")
    .map((check) => ({
      id: check.id,
      severity: check.severity,
      status: check.status,
      summary: redactText(check.summary),
      impact: redactText(check.impact),
      action: redactText(check.action),
    }));
  const logExcerpt = readSanitizedLog();
  const prompt = [
    "I am troubleshooting a local OpenLeaf install. Here is a sanitized support report.",
    "Do not ask me to paste manuscript source, passwords, or invitation links.",
    "Tell me the most likely cause and the next command to run.",
    "",
    JSON.stringify({ schemaVersion: CHECK_SCHEMA_VERSION, failingChecks, logExcerpt }, null, 2),
  ].join("\n");
  return {
    schemaVersion: CHECK_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    openleafVersion: openleafVersion(),
    node: process.version,
    platform: platformLabel(),
    failingChecks,
    logExcerpt,
    prompt,
  };
}

export function formatSupportReport(report: SupportReport): string {
  const lines = [
    "OpenLeaf support report",
    `schema ${report.schemaVersion} · version ${report.openleafVersion} · node ${report.node}`,
    `platform ${report.platform}`,
    "",
    report.failingChecks.length ? "Failures:" : "No failed checks.",
  ];
  for (const check of report.failingChecks) {
    lines.push(`- [${check.severity}] ${check.id}: ${check.summary}`);
    lines.push(`  Impact: ${check.impact}`);
    if (check.action) lines.push(`  Next: ${check.action}`);
  }
  if (report.logExcerpt) {
    lines.push("", "Sanitized log excerpt:", report.logExcerpt);
  }
  lines.push(
    "",
    "Paste the following into an AI assistant. Nothing is uploaded automatically.",
    "",
    report.prompt,
  );
  return lines.join("\n");
}
