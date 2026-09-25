export type ExitCode = 0 | 1 | 2 | 3;

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: ExitCode = 1,
  ) {
    super(message);
    this.name = "CliError";
  }
}

let jsonMode = false;

export function setJsonMode(on: boolean): void {
  jsonMode = on;
}

export function isJsonMode(): boolean {
  return jsonMode;
}

/** Human text. Suppressed when stdout is reserved for JSON. */
export function out(line = ""): void {
  if (jsonMode) return;
  process.stdout.write(`${line}\n`);
}

export function warn(line: string): void {
  if (jsonMode) return;
  process.stderr.write(`${line}\n`);
}

export function fail(message: string, exitCode: ExitCode = 1): never {
  if (jsonMode) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
  } else {
    process.stderr.write(`${message}\n`);
  }
  process.exit(exitCode);
}

export function emitJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
