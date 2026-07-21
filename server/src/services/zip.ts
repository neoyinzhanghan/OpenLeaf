import archiver from "archiver";
import fs from "node:fs";
import path from "node:path";
import type { Response } from "express";
import { ZIP_SKIP_DIRS, projectDir } from "./projectFs.js";

export function streamProjectZip(id: string, res: Response): void {
  const root = projectDir(id);
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

  const walk = (dir: string, rel: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ZIP_SKIP_DIRS.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(abs, childRel);
      else archive.file(abs, { name: `${id}/${childRel}` });
    }
  };
  walk(root, "");
  void archive.finalize();
}
