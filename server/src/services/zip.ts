import archiver from "archiver";
import fs from "node:fs";
import path from "node:path";
import type { Response } from "express";
import { ZIP_SKIP_DIRS, projectDir } from "./projectFs.js";

/** Relative file paths that would be included in a project ZIP of `root`. */
export function collectZipFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string, rel: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (ZIP_SKIP_DIRS.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(abs, childRel);
      else files.push(childRel);
    }
  };
  walk(root, "");
  files.sort();
  return files;
}

export function streamProjectZip(id: string, res: Response, opts?: { rootDir?: string }): void {
  const root = opts?.rootDir ?? projectDir(id);
  if (!fs.existsSync(root)) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${id}.zip"`);

  const archive = archiver("zip", { zlib: { level: 9 } });
  archive.on("error", (err) => {
    res.status(500).end(String(err));
  });
  archive.pipe(res);

  for (const rel of collectZipFiles(root)) {
    archive.file(path.join(root, rel), { name: `${id}/${rel}` });
  }
  void archive.finalize();
}
