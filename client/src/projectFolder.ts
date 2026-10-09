import filenamify from "filenamify/browser";

/**
 * Filesystem folder for a display name. Same filenamify options as the server.
 * Returns null when the title cannot become a folder.
 */
export function projectFolderName(displayName: string): string | null {
  const name = displayName.trim();
  if (!name || name.length > 120 || /[\u0000-\u001F\u007F]/.test(name)) return null;
  let folder = filenamify(name, { replacement: "-", maxLength: 80 });
  folder = folder.replace(/^\.+/, "").trim();
  if (
    !folder ||
    folder === "." ||
    folder === ".." ||
    folder.startsWith(".") ||
    /^-+$/.test(folder) ||
    /[\\/\u0000-\u001F\u007F]/.test(folder) ||
    /[. ]$/.test(folder)
  ) {
    return null;
  }
  return folder;
}
