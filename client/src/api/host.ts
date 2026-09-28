export type HostDevice = {
  id: string;
  label: string;
  userAgent: string;
  route: "lan" | "tunnel" | "password";
  createdAt: number;
  lastSeenAt: number;
  lastIp: string;
  revokedAt?: number;
};

export type LanAddress = {
  address: string;
  name: string;
  kind: "wifi" | "tailscale" | "virtual";
  label: string;
};

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* keep message */
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export function fetchLanAddresses(): Promise<{ wsl: boolean; addresses: LanAddress[] }> {
  return request("/api/host/lan-addresses");
}

export function createHostPairing(body: {
  route: "lan" | "tunnel";
  lanAddress?: string;
  next?: string;
  riskAck?: boolean;
}): Promise<{ id: string; url: string; expiresAt: number }> {
  return request("/api/host/pairings", { method: "POST", body: JSON.stringify(body) });
}

export function fetchHostPairing(id: string): Promise<{
  status: "pending" | "redeemed" | "expired";
  expiresAt: number;
  device?: HostDevice;
}> {
  return request(`/api/host/pairings/${encodeURIComponent(id)}`);
}

export function cancelHostPairing(id: string): Promise<{ ok: boolean }> {
  return request(`/api/host/pairings/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function fetchHostDevices(): Promise<{ devices: HostDevice[] }> {
  return request("/api/host/devices");
}

export function revokeHostDevice(id: string): Promise<{ ok: boolean }> {
  return request(`/api/host/devices/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function revokeAllHostDevices(): Promise<{ ok: boolean }> {
  return request("/api/host/devices/revoke-all", { method: "POST", body: "{}" });
}

export function renameHostDevice(id: string, label: string): Promise<{ device: HostDevice }> {
  return request(`/api/host/devices/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ label }),
  });
}

export function revealHostPassword(): Promise<{ password: string }> {
  return request("/api/host/password/reveal", { method: "POST", body: "{}" });
}

export function resetHostPassword(password: string): Promise<{ ok: boolean; username: string }> {
  return request("/api/host/password/reset", { method: "POST", body: JSON.stringify({ password }) });
}

export function stopPhoneAccess(): Promise<{ ok: boolean }> {
  return request("/api/host/lan/stop", { method: "POST", body: "{}" });
}

export function stopRemoteAccess(): Promise<{ ok: boolean }> {
  return request("/api/host/remote", { method: "DELETE" });
}
