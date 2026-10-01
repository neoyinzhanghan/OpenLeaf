import filenamify from "filenamify";

const FOLDER_MAX = 80;
export const DISPLAY_NAME_MAX = 120;

/** The title people see. Spaces and punctuation stay. */
export function normalizeDisplayName(raw: string): string {
  const name = raw.trim();
  if (!name || name.length > DISPLAY_NAME_MAX) {
    throw Object.assign(new Error("Enter a project name"), { status: 400 });
  }
  if (/[\u0000-\u001F\u007F]/.test(name)) {
    throw Object.assign(new Error("That name contains characters that cannot be shown"), { status: 400 });
  }
  return name;
}

/**
 * Filesystem folder for a display name.
 * filenamify replaces characters that are illegal in a file name.
 */
export function projectFolderName(displayName: string): string {
  const name = normalizeDisplayName(displayName);
  let folder = filenamify(name, { replacement: "-", maxLength: FOLDER_MAX });
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
    throw Object.assign(new Error("That name cannot be saved as a folder"), { status: 400 });
  }
  return folder;
}
