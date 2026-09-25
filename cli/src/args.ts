const BOOLEAN_FLAGS = new Set([
  "help",
  "json",
  "yes",
  "follow",
  "fix",
  "smoke",
  "non-interactive",
  "skip-build",
  "skip-start",
  "skip-compile",
  "skip-open",
  "generate",
  "version",
  "password-stdin",
]);

export type ParsedArgs = {
  positionals: string[];
  flags: Map<string, string | true>;
};

export function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string | true>();
  const positionals: string[] = [];
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === "--") {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    if (eq >= 0) {
      flags.set(body.slice(0, eq), body.slice(eq + 1));
      continue;
    }
    if (BOOLEAN_FLAGS.has(body)) {
      flags.set(body, true);
      continue;
    }
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(body, next);
      i += 1;
      continue;
    }
    flags.set(body, true);
  }
  return { positionals, flags };
}

export function flagString(flags: Map<string, string | true>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" ? value : undefined;
}

export function flagBool(flags: Map<string, string | true>, name: string): boolean {
  return flags.get(name) === true || flags.get(name) === "true";
}
