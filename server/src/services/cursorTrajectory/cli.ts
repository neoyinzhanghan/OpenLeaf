import { ingestHookStdin } from "./recorder.js";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  try {
    const raw = await readStdin();
    await ingestHookStdin(raw);
  } catch (err) {
    console.error("[cursor-trajectory]", err instanceof Error ? err.message : err);
  }
  process.stdout.write("{}\n");
}

void main();
