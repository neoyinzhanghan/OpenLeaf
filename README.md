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
- Temporary public links per project (Cloudflare Quick Tunnel + one-off credentials), see below

## Sharing a project publicly

The **Share** button in the editor opens a temporary public link for *that project only*. Under the hood OpenLeaf spawns `cloudflared tunnel --url http://127.0.0.1:<port>` and gets a random `https://<words>.trycloudflare.com` address; nothing is stored, so ending the session (or restarting the server) kills the link, and the next session gets a new address and new credentials.

Requirements: [`cloudflared`](https://github.com/cloudflare/cloudflared/releases) on the host machine (found via `PATH`, `~/.local/bin`, `/usr/local/bin`, or `OPENLEAF_CLOUDFLARED=/path/to/cloudflared`). No Cloudflare account or domain is needed.

When creating a link the host chooses:

- **Expiry** (preset, exact date/time, or **indefinite**) — finite deadlines self-terminate the session (max 30 days); indefinite runs until you click End session. The host toolbar shows a live countdown while a timed session is open.
- **Max unique IPs** (default 2) — how many distinct client addresses may ever authenticate on this link.
- **Max guests** (default 3) — how many people may be signed in.
- **Read-only** — guests can follow along; file writes, uploads, renames and even Yjs updates over the WebSocket are dropped server-side.
- **Allow compile / downloads / history** — restore from history is always host-only.

Each session gets three independent secrets, all regenerated every time:

- **Invitation link** — `https://<cloudflare-words>.trycloudflare.com/join/<star>-<moon>-<digits>` (e.g. `…/join/vega-callisto-418`). The hostname is assigned by Cloudflare; the `/join/…` code is drawn from a celestial word bank and is deliberately unrelated to the username. Opening it sets a cookie that is required before credentials are accepted, so leaked credentials without the link (or vice-versa) are useless.
- **Username** — `<creature>-<4 digits>` from a bank of 1,000 animals and mythical beings (`griffin-4821`, `axolotl-2093`, `kitsune-7310`).
- **Password** — 16 characters, Chrome-style: upper/lower/digit/symbol guaranteed, ambiguous glyphs (`0 O 1 l I`) excluded.

While a session runs the host panel shows a live countdown, device and guest usage meters, every IP seen (with who signed in from it and failed-login counts) and an activity feed. The deadline can be extended (+15 min / +1 h / +4 h / +1 day, or an exact time) and the device / guest caps raised or lowered on the fly (`PATCH /api/projects/:id/share`) without ending the session: link, username and password stay the same and signed-in guests are not interrupted.

Guests open the invitation link, enter the username and password, and **must give a display name**, which becomes their cursor label and their git author name. The host sees who is connected (name, IP, join time) and can kick anyone. A guest link only ever reaches `/api/projects/<that project>/…` and the collab socket for that project; the project list, server config, identities and sharing controls are host-only.

New `trycloudflare.com` hostnames can take 10–30 s to resolve everywhere; if a guest sees "could not resolve host" right after you create the link, have them retry.

## Security note

OpenLeaf is meant for trusted local or LAN use. On the local port there is **no authentication**: anyone who can reach the host directly can read and write project files and trigger compiles. Do not port-forward it; use the Share feature above (which adds sign-in, project scoping and limits) when someone remote needs access, and only give the credentials to people you trust — a guest with write access can still put arbitrary files into the shared project and run `latexmk` on your machine.

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
