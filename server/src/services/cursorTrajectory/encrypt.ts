import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import * as age from "age-encryption";

const RECIPIENT_RE = /^age1[0-9a-z]+$/i;

export async function encryptToRecipients(plaintext: string | Uint8Array, recipients: string[]): Promise<Uint8Array> {
  if (recipients.length === 0) {
    throw new Error("No age recipients");
  }
  const encrypter = new age.Encrypter();
  for (const recipient of recipients) encrypter.addRecipient(recipient);
  return encrypter.encrypt(plaintext);
}

export async function decryptWithIdentity(
  ciphertext: Uint8Array,
  identity: string,
): Promise<Uint8Array> {
  const decrypter = new age.Decrypter();
  decrypter.addIdentity(identity.trim());
  const out = await decrypter.decrypt(ciphertext);
  return out instanceof Uint8Array ? out : new TextEncoder().encode(String(out));
}

export function parseRecipientsText(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    for (const token of line.split(/[\s,]+/)) {
      if (RECIPIENT_RE.test(token) && !seen.has(token)) {
        seen.add(token);
        out.push(token);
      }
    }
  }
  return out;
}

export async function generateTrajectoryIdentity(): Promise<{ identity: string; recipient: string }> {
  const identity = await age.generateIdentity();
  const recipient = await age.identityToRecipient(identity);
  return { identity, recipient };
}

export function defaultUserConfigDir(): string {
  return path.join(os.homedir(), ".openleaf");
}

export function readRecipientsFile(filePath: string): string[] {
  if (!fsSync.existsSync(filePath)) return [];
  try {
    return parseRecipientsText(fsSync.readFileSync(filePath, "utf8"));
  } catch {
    return [];
  }
}

export async function atomicWriteFile(dest: string, data: Uint8Array | string, mode = 0o600): Promise<void> {
  await fs.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
  const tmp = `${dest}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  await fs.writeFile(tmp, data, { mode });
  await fs.rename(tmp, dest);
  await fs.chmod(dest, mode).catch(() => undefined);
}
