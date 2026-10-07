import readline from "node:readline";
import { CliError } from "./output.js";

export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export async function promptLine(label: string, fallback?: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new CliError(
      `This step needs a terminal answer (${label}). Re-run with the matching flag, for example --display-name.`,
      2,
    );
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const suffix = fallback ? ` [${fallback}]` : "";
  const answer = await new Promise<string>((resolve) => {
    rl.question(`${label}${suffix}: `, (value) => resolve(value.trim()));
  });
  rl.close();
  return answer || fallback || "";
}

export async function confirm(label: string, fallbackYes: boolean): Promise<boolean> {
  if (!process.stdin.isTTY) {
    throw new CliError(`${label} needs confirmation. Re-run with --yes to allow it, or omit the flag to skip.`, 2);
  }
  const hint = fallbackYes ? "Y/n" : "y/N";
  const answer = (await promptLine(`${label} (${hint})`)).toLowerCase();
  if (!answer) return fallbackYes;
  return answer === "y" || answer === "yes";
}

export async function promptSecret(label: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) {
    throw new CliError(
      `${label} needs a terminal, or pass --password-stdin / --generate so the secret is not a process argument.`,
      2,
    );
  }
  process.stderr.write(`${label}: `);
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const onData = (ch: string) => {
      if (ch === "\u0003") {
        cleanup();
        reject(new CliError("Cancelled.", 2));
        return;
      }
      if (ch === "\n" || ch === "\r" || ch === "\u0004") {
        cleanup();
        process.stderr.write("\n");
        resolve(value);
        return;
      }
      if (ch === "\u007F" || ch === "\b") {
        value = value.slice(0, -1);
        return;
      }
      if (ch < " " || ch === "\u001b") return;
      value += ch;
    };
    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
    };
    stdin.on("data", onData);
  });
}

export async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new CliError("Pass the password on stdin (a pipe), not as an argument.", 2);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8").trim();
}
