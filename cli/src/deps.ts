import { execFile } from "node:child_process";
import os from "node:os";
import fs from "node:fs";
import { texEnv } from "../../server/src/services/compiler.js";
import { toolLookup } from "./platform.js";

export type ToolId = "git" | "pdflatex" | "xelatex" | "bibtex" | "latexmk" | "latexdiff" | "cloudflared";

const HINTS: Record<ToolId, { linux: string; darwin: string; win32: string }> = {
  git: {
    linux: "Install Git with your package manager, for example: sudo apt install git",
    darwin: "Install Git from https://git-scm.com/download/mac or: brew install git",
    win32: "Install Git from https://git-scm.com/download/win",
  },
  pdflatex: {
    linux: "Install TeX Live, for example: sudo apt install texlive-latex-recommended",
    darwin: "Install MacTeX from https://www.tug.org/mactex/ or: brew install --cask mactex-no-gui",
    win32: "Install TeX Live or MiKTeX and ensure pdflatex is on PATH",
  },
  xelatex: {
    linux: "Install XeLaTeX, for example: sudo apt install texlive-xetex",
    darwin: "Install MacTeX from https://www.tug.org/mactex/",
    win32: "Install TeX Live or MiKTeX and ensure xelatex is on PATH",
  },
  bibtex: {
    linux: "Install BibTeX support, for example: sudo apt install texlive-bibtex-extra",
    darwin: "BibTeX ships with MacTeX",
    win32: "Install a full TeX Live or MiKTeX scheme so bibtex is on PATH",
  },
  latexmk: {
    linux: "Optional: sudo apt install latexmk",
    darwin: "Optional: included with MacTeX, or brew install latexmk",
    win32: "Optional: install latexmk via TeX Live or MiKTeX",
  },
  latexdiff: {
    linux: "Optional, for track-changes PDFs: sudo apt install latexdiff",
    darwin: "Optional: included with MacTeX, or brew install latexdiff",
    win32: "Optional: install latexdiff via TeX Live or MiKTeX",
  },
  cloudflared: {
    linux: "Optional, for public links: https://github.com/cloudflare/cloudflared/releases",
    darwin: "Optional, for public links: brew install cloudflared",
    win32: "Optional, for public links: https://github.com/cloudflare/cloudflared/releases",
  },
};

export function installHint(tool: ToolId): string {
  const hints = HINTS[tool];
  if (process.platform === "darwin") return hints.darwin;
  if (process.platform === "win32") return hints.win32;
  return hints.linux;
}

export function commandExists(bin: string): Promise<boolean> {
  const lookup = toolLookup(bin);
  const file = fs.existsSync(lookup.file) ? lookup.file : process.platform === "win32" ? "where.exe" : "which";
  return new Promise((resolve) => {
    execFile(file, lookup.args, { timeout: 5000, env: texEnv(), windowsHide: true }, (err) => resolve(!err));
  });
}

export function nodeMajor(): number {
  const match = /^v(\d+)/.exec(process.version);
  return match ? Number(match[1]) : 0;
}

export function platformLabel(): string {
  return `${os.platform()} ${os.release()} ${os.arch()}`;
}
