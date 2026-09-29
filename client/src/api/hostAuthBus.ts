type Listener = () => void;

const listeners = new Set<Listener>();

/** Fired when an API call returns 401 HOST_AUTH so the UI can return to sign-in. */
export function onHostAuthRequired(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function noteHostAuth(status: number, code: string | undefined): void {
  if (status !== 401 || code !== "HOST_AUTH") return;
  for (const listener of listeners) listener();
}
