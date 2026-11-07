/** Operating system reported by the browser that will paste the path. */
export type ClientOs = "windows" | "mac" | "linux" | "other";

/**
 * The machine the person is using. Phones are "other": the copied path then
 * uses the computer that stores the file (Windows UNC under WSL, POSIX on Mac/Linux).
 */
export function clientOs(): ClientOs {
  if (typeof navigator === "undefined") return "other";
  const ua = navigator.userAgent || "";
  if (/Android|iPhone|iPad|iPod/i.test(ua)) return "other";
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ||
    navigator.platform ||
    "";
  const blob = `${platform} ${ua}`;
  if (/Win/i.test(blob)) return "windows";
  if (/Mac/i.test(blob)) return "mac";
  if (/Linux|X11|CrOS/i.test(blob)) return "linux";
  return "other";
}
