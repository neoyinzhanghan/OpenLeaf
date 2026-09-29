import { useEffect, useId, useRef, useState } from "react";
import QRCode from "qrcode";
import {
  cancelHostPairing,
  createHostPairing,
  fetchHostDevices,
  fetchHostPairing,
  fetchLanAddresses,
  renameHostDevice,
  revealHostPassword,
  revokeAllHostDevices,
  revokeHostDevice,
  stopPhoneAccess,
  stopRemoteAccess,
  type HostDevice,
  type LanAddress,
} from "../api/host";
import { hostGateway } from "../api/share";
import { copyText } from "../lib/clipboard";
import { useFocusTrap } from "../ui/useFocusTrap";

type Props = {
  open: boolean;
  onClose: () => void;
  nextPath?: string;
};

export function HostAccessPanel({ open, onClose, nextPath = "/" }: Props) {
  const titleId = useId();
  const [addresses, setAddresses] = useState<LanAddress[]>([]);
  const [wsl, setWsl] = useState(false);
  const [picked, setPicked] = useState("");
  const [route, setRoute] = useState<"lan" | "tunnel">("lan");
  const [riskAck, setRiskAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<{ id: string; url: string; expiresAt: number } | null>(null);
  const [qr, setQr] = useState("");
  const [status, setStatus] = useState("Waiting for your phone…");
  const [now, setNow] = useState(Date.now());
  const [devices, setDevices] = useState<HostDevice[]>([]);
  const [password, setPassword] = useState<string | null>(null);
  const [phoneOn, setPhoneOn] = useState<string | null>(null);
  const [remoteOn, setRemoteOn] = useState(false);
  const routeTouched = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(open, dialogRef);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) {
      routeTouched.current = false;
      return;
    }
    void fetchLanAddresses()
      .then((result) => {
        setAddresses(result.addresses);
        setWsl(result.wsl);
        const first = result.addresses.find((item) => item.kind === "wifi") ?? result.addresses[0];
        setPicked(first?.address ?? "");
        setPhoneOn(result.running?.address ?? null);
        if (!routeTouched.current) setRoute(result.wsl || !first ? "tunnel" : "lan");
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Could not list network addresses"));
    void fetchHostDevices()
      .then((result) => setDevices(result.devices.filter((device) => !device.revokedAt)))
      .catch(() => setDevices([]));
    void hostGateway()
      .then((gateway) => setRemoteOn(gateway.status === "active" || gateway.status === "starting"))
      .catch(() => setRemoteOn(false));
  }, [open]);

  useEffect(() => {
    if (!link) return;
    void QRCode.toString(link.url, { type: "svg", margin: 1, width: 240 }).then(setQr);
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    const poll = window.setInterval(() => {
      void fetchHostPairing(link.id).then((pairing) => {
        if (pairing.status === "redeemed" && pairing.device) {
          setStatus(`✓ Connected: ${pairing.device.label} (${pairing.device.lastIp})`);
          void fetchHostDevices().then((result) => setDevices(result.devices.filter((device) => !device.revokedAt)));
        } else if (pairing.status === "expired") {
          setStatus("This link has expired. Choose New link.");
        }
      });
    }, 1500);
    return () => {
      window.clearInterval(tick);
      window.clearInterval(poll);
    };
  }, [link]);

  if (!open) return null;

  const remaining = link ? Math.max(0, Math.ceil((link.expiresAt - now) / 1000)) : 0;
  const mm = String(Math.floor(remaining / 60)).padStart(1, "0");
  const ss = String(remaining % 60).padStart(2, "0");

  const makeLink = async () => {
    setBusy(true);
    setError(null);
    try {
      const created = await createHostPairing({
        route,
        lanAddress: route === "lan" ? picked : undefined,
        next: nextPath,
        riskAck: route === "tunnel" ? riskAck : undefined,
      });
      setLink(created);
      setStatus("Waiting for your phone…");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create a link");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="host-access-backdrop" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        className="host-access-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="host-access-head">
          <h2 id={titleId}>Open on your phone</h2>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Close
          </button>
        </header>
        {wsl && (
          <p className="host-access-note">
            OpenLeaf is running inside WSL. Your phone usually can't reach WSL's internal address. Use From
            anywhere, or turn on WSL mirrored networking (`networkingMode=mirrored` in %UserProfile%\.wslconfig) and
            allow the port in Windows Firewall.
          </p>
        )}
        <div className="host-access-routes">
          <label>
            <input
              type="radio"
              name="phone-route"
              checked={route === "lan"}
              onChange={() => {
                routeTouched.current = true;
                setRoute("lan");
              }}
            />{" "}
            Same
            Wi-Fi (fastest)
          </label>
          <label>
            <input
              type="radio"
              name="phone-route"
              checked={route === "tunnel"}
              onChange={() => {
                routeTouched.current = true;
                setRoute("tunnel");
              }}
            />{" "}
            From anywhere (via Cloudflare)
          </label>
        </div>
        {route === "lan" && (
          <label className="host-access-field">
            Address
            <select value={picked} onChange={(event) => setPicked(event.target.value)}>
              {addresses.map((item) => (
                <option key={item.address} value={item.address}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
        )}
        {route === "tunnel" && (
          <label className="host-access-check">
            <input type="checkbox" checked={riskAck} onChange={(event) => setRiskAck(event.target.checked)} />
            I understand this creates a public link to the OpenLeaf on this computer.
          </label>
        )}
        {error && <div className="error-banner">{error}</div>}
        {!link ? (
          <button type="button" className="btn btn-primary" disabled={busy || (route === "tunnel" && !riskAck)} onClick={() => void makeLink()}>
            {busy ? (route === "tunnel" ? "Starting tunnel…" : "Starting…") : "Create link"}
          </button>
        ) : (
          <div className="host-access-link">
            <div className="host-access-qr" dangerouslySetInnerHTML={{ __html: qr }} />
            <code>{link.url}</code>
            <p>Scan the QR code on your phone. If you paste the link into a chat, the preview may not work.</p>
            <p>
              Single use · expires in {mm}:{ss}
            </p>
            <p>{status}</p>
            <div className="host-access-actions">
              <button type="button" className="btn" onClick={() => void copyText(link.url)}>
                Copy
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  void cancelHostPairing(link.id);
                  setLink(null);
                }}
              >
                New link
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  void cancelHostPairing(link.id);
                  setLink(null);
                  onClose();
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
        <h3>Signed-in devices</h3>
        <ul className="host-access-devices">
          {devices.length === 0 && <li>No other devices yet.</li>}
          {devices.map((device) => (
            <li key={device.id}>
              <input
                aria-label={`Name for ${device.label}`}
                defaultValue={device.label}
                onBlur={(event) => {
                  const label = event.target.value.trim();
                  if (label && label !== device.label) void renameHostDevice(device.id, label);
                }}
              />
              <span>
                {device.route} · {device.lastIp}
              </span>
              <button type="button" className="btn" onClick={() => void revokeHostDevice(device.id).then(() => setDevices((list) => list.filter((item) => item.id !== device.id)))}>
                Sign out
              </button>
            </li>
          ))}
        </ul>
        <div className="host-access-actions">
          <button type="button" className="btn" onClick={() => void revokeAllHostDevices().then(() => setDevices([]))}>
            Sign out all devices
          </button>
          {phoneOn && <p>Phone access on {phoneOn}</p>}
          {remoteOn && <p>Public link active</p>}
          {phoneOn && (
            <button type="button" className="btn" onClick={() => void stopPhoneAccess().then(() => setPhoneOn(null))}>
              Stop phone access
            </button>
          )}
          {remoteOn && (
            <button
              type="button"
              className="btn"
              onClick={() => void stopRemoteAccess().then(() => setRemoteOn(false))}
            >
              Stop remote access
            </button>
          )}
          <button
            type="button"
            className="btn"
            onClick={() => {
              if (password) {
                setPassword(null);
                return;
              }
              void revealHostPassword().then((result) => setPassword(result.password));
            }}
          >
            {password ? "Hide host password" : "Show host password"}
          </button>
        </div>
        {password && <code className="host-access-password">{password}</code>}
      </div>
    </div>
  );
}
