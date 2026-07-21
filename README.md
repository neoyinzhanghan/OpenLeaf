> **Note:** This project (including this README) was written with AI assistance.

<p align="center">
  <img src="client/public/logo.png" alt="OpenLeaf logo" width="160" />
</p>

# OpenLeaf

## Overview

OpenLeaf is a **local-first LaTeX editor built for hackers and AI**.

It gives you the Overleaf-style experience—split source and PDF, compile in the browser, realtime collab on your LAN—without locking your paper inside someone else’s cloud. Every project is a normal folder on disk. The UI is just a thin window onto files you already own.

That is the point. You are not a tenant in a black-box editor. You control **everything**:

- the paper itself (`main.tex`, `sections/`, `figures/`, `metrics.tex`, `misc/`, …)
- the app stack (`server/`, `client/`, `config/`)
- how compile, collab, identities, and git backups behave

Want a custom macro workflow, a metrics file your agent updates, a one-off script under `scripts/`, or a change to the compile pipeline? Open the repo and do it. Pair OpenLeaf with **Cursor**, **Claude Code**, or any coding agent in the same workspace: rewrite sections, generate figures, fix citations, reshape the project layout—while the browser stays open on the live PDF. The agent edits the same files OpenLeaf compiles. No export/import dance. No “paste into Overleaf.” Just your machine, your TeX, your tools.

**Typical loop**

1. Create or open a project (`example-article` ships as a template).
2. Edit in Monaco—or let an AI agent edit the project folder beside you.
3. **Ctrl/Cmd+S** saves to disk and (by default) auto-compiles.
4. Review the PDF, SyncTeX-jump from preview to source, download PDF or ZIP.
5. Co-edit on the LAN with preset identities; use **History** for per-project git backups.

OpenLeaf is for trusted local or LAN use. There is no authentication—by design, because the filesystem *is* the product.

## Prerequisites

- **Node.js 20+** ([nodejs.org](https://nodejs.org/) or your package manager)
- **TeX Live** with at least `pdflatex` and `bibtex` (`latexmk` recommended)
  - Ubuntu/Debian: `sudo apt install texlive-latex-recommended texlive-bibtex-extra latexmk`
  - macOS: [MacTeX](https://www.tug.org/mactex/) or `brew install --cask mactex-no-gui`
- **Git** (used for per-project version history; optional if you set `"git": { "enabled": false }`)

## Install and run

```bash
git clone <your-repo-url> OpenLeaf
cd OpenLeaf
npm install
npm run dev
```

`npm run dev` starts two processes:

| Service | Port | Role |
|---------|------|------|
| Vite UI | **5173** | The app you open in the browser |
| Express API | **8787** | Compile, files, collab WebSocket |

**During development, open the Vite URL**, not the API port:

- Local: [http://127.0.0.1:5173](http://127.0.0.1:5173)
- On your LAN: `http://<your-lan-ip>:5173` (both servers bind to `0.0.0.0`)

Vite proxies `/api` and `/collab` to the backend. Visiting `:8787` in dev redirects to Vite so you do not accidentally use a stale build.

### Production-style run

```bash
npm run build
npm start
```

Then open [http://127.0.0.1:8787](http://127.0.0.1:8787) (API serves the built UI).

## First-time usage

1. Open the UI and you will see **Projects**.
2. Click **example-article** (ships with the repo) or create a new project (**New from example** copies that template).
3. Edit LaTeX in the Monaco editor. **Ctrl/Cmd+S** saves to disk and (by default) auto-compiles.
4. Use **Recompile** for a manual build; watch the log and PDF panes.
5. Download **PDF** or **ZIP** from the toolbar when needed.

### Toolbar cheat sheet

| Control | What it does |
|---------|----------------|
| **You** dropdown | Pick your collab identity for this project (from `openleaf.json`) |
| Theme toggle | Light / dark (default is dark; preference stored in the browser) |
| **History** | Per-project git snapshots; restore a previous save |
| **Save & sync** | Flush live collab edits to disk and commit a backup |
| **Recompile** | Run the TeX engine |
| **PDF** / **ZIP** | Download outputs |

### Collaboration

- Identities are **per project**, listed in `projects/<id>/openleaf.json` under `identities`.
- New projects are seeded from `defaultIdentities` in [`config/default.json`](config/default.json).
- Open the same project in two browsers, pick different identities, and edit — changes sync over WebSocket (`/collab/<project>`).
- Presence chips in the toolbar show who is connected.

### Version history

Each project gets its own git repo under `projects/<id>/` (ignored by the OpenLeaf repo’s `.gitignore`). Explicit saves and file-tree mutations auto-commit; background collab flushes do not. Use **History** in the UI to browse and restore. Disable with `"git": { "enabled": false }` in config.

## Project layout

```
projects/my-paper/
  main.tex
  metrics.tex       # optional shared number macros (\input{metrics})
  references.bib
  openleaf.json     # mainFile, engine, identities[]
  sections/         # \input{sections/...} from main.tex
  figures/
  assets/
  scripts/
  misc/             # notes, drafts, non-compiled material
  .openleaf/        # build + collab runtime (gitignored; not in ZIP)
```

Only `projects/example-article/` is tracked in git. Your real papers under `projects/` stay local (see `.gitignore`).

## Configuration

Priority: `config/default.json` → `config/local.json` (gitignored) → env vars.

| Variable | Meaning |
|----------|---------|
| `OPENLEAF_HOST` | Bind address (default `0.0.0.0`) |
| `OPENLEAF_PORT` | API port (default `8787`) |
| `OPENLEAF_PROJECTS_ROOT` | Projects directory |
| `OPENLEAF_ENGINE` | `pdflatex` or `xelatex` |

You can also `GET` / `PATCH /api/config` (PATCH writes `config/local.json`).

If you change the API port, update the Vite proxy target in [`client/vite.config.ts`](client/vite.config.ts) to match.

## Features

- Full project filesystem: create / rename / delete / upload any path under the project
- Monaco LaTeX editing with SyncTeX (click PDF → jump to source)
- Auto-compile on save, compile logs, PDF.js preview, resizable panes
- Realtime multi-user editing (Yjs) with preset identities
- Per-project git backups and History UI
- Light / dark theme
- Download PDF or project ZIP (excludes `.openleaf/`)

## Security note

OpenLeaf is meant for trusted local or LAN use. There is **no authentication**. Anyone who can reach the host can read and write project files and trigger compiles. Do not expose it to the public internet without putting it behind your own access control.

## Repository layout

| Path | Role |
|------|------|
| `client/` | React + Vite UI |
| `server/` | Express API, compile, collab, git backups |
| `config/` | Default settings |
| `projects/` | LaTeX projects (example ships; others local) |
| `AGENTS.md` | Notes for coding agents / contributors |

## License

MIT — see [LICENSE](LICENSE).
