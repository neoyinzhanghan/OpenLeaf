/** PDF.js races while switching papers — noisy, not actionable. */
export function isTransientPdfError(err: unknown): boolean {
  const parts: string[] = [];
  if (typeof err === "string") parts.push(err);
  if (err instanceof Error) {
    parts.push(err.message, err.name, err.stack ?? "");
  } else if (err && typeof err === "object") {
    const o = err as Record<string, unknown>;
    for (const key of ["message", "name", "details", "reason"]) {
      if (typeof o[key] === "string") parts.push(o[key] as string);
    }
    try {
      parts.push(JSON.stringify(err));
    } catch {
      parts.push(String(err));
    }
  } else if (err != null) {
    parts.push(String(err));
  }
  const text = parts.join("\n");
  return (
    /sendWithPromise/i.test(text) ||
    /messageHandler/i.test(text) ||
    /WorkerTransport/i.test(text) ||
    /transport destroyed/i.test(text) ||
    /worker.*(destroy|terminated|killed|being destroyed)/i.test(text) ||
    /Cannot read propert(?:y|ies) of null/i.test(text) && /sendWithPromise|messageHandler|WorkerTransport/i.test(text)
  );
}

export function isTransientPdfErrorMessage(message: string | null | undefined): boolean {
  if (!message) return false;
  return isTransientPdfError(message);
}
