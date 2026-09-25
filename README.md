> **Note:** This project (including this README) was written with AI assistance.

<p align="center">
  <img src="client/public/logo.png" alt="OpenLeaf logo" width="160" />
</p>

# OpenLeaf

## Overview

OpenLeaf is a **local-first LaTeX editor built for hackers and AI**.

It gives you the Overleaf-style experience—split source and PDF, compile in the browser, realtime collab on your LAN—without locking your paper inside someone else’s cloud. Every project is a normal folder on disk. The UI is just a thin window onto files you already own.

Localhost is open on purpose. A public link uses a separate host login. Your collaboration display name is not that login.

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

OpenLeaf is for trusted local or LAN use. Localhost does not ask you to sign in. The public host link does.

## Prerequisites

Node.js 20 or newer, from [nodejs.org](https://nodejs.org/). Git is needed for per-project history. A TeX install must provide `pdflatex` and `bibtex`. `latexmk` is recommended. `latexdiff` is optional and is only used for track-changes PDFs.

OpenLeaf looks for TeX in the usual install locations even when a GUI shell does not put them on `PATH` (MacTeX, Homebrew, MiKTeX, TeX Live, TinyTeX). Setup and `openleaf doctor` print the install step for the computer you are on. They do not run the installer for you.

| System | TeX | Git |
|--------|-----|-----|
| Windows PowerShell | [TeX Live](https://tug.org/texlive/) or [MiKTeX](https://miktex.org/) | [git-scm.com](https://git-scm.com/download/win) |
| macOS Terminal | [MacTeX](https://www.tug.org/mactex/) or `brew install --cask mactex-no-gui` | `brew install git`, or the Xcode command-line tools |
| Linux | `sudo apt install texlive-latex-recommended texlive-bibtex-extra latexmk` | `sudo apt install git` |

`latexdiff` on Windows and macOS ships with TeX Live / MacTeX. On Debian or Ubuntu it is a separate package: `sudo apt install latexdiff`.

## Install and run

Ordinary use is the CLI. From a fresh checkout:

```bash
git clone <your-repo-url> OpenLeaf
cd OpenLeaf
npm install
node cli/bin/openleaf.js setup
```

`npm install` is the bootstrap. The `openleaf` command is not published to npm; `node cli/bin/openleaf.js` works before `npm run build`. After install you can also run `npx openleaf` or `npm run openleaf -- setup`.

The same commands work in **Windows PowerShell** and **macOS Terminal**. Quote the path if it contains spaces.

```powershell
cd C:\path\OpenLeaf
npm install
node cli/bin/openleaf.js setup
node cli/bin/openleaf.js start
```

```bash
cd ~/OpenLeaf
npm install
node cli/bin/openleaf.js setup
node cli/bin/openleaf.js start
```

On Windows, `stop` uses `taskkill` only after PowerShell confirms the process command line belongs to this install. On macOS, that check uses `ps -ww`. Neither platform stops a program merely because it is listening on the port. `open` uses `Start-Process` in Windows PowerShell and `open` on macOS.

Setup asks for a display name, a projects directory outside this checkout, and who can reach the editor. New installs bind to localhost only. It then builds the app, starts it, compiles a sample PDF, and prints the editor URL.

Check status any time with:

```bash
node cli/bin/openleaf.js
node cli/bin/openleaf.js status
node cli/bin/openleaf.js doctor
```

Running `openleaf` with no arguments prints the current state and the next commands. In a non-interactive shell it does not wait for input.

### Contributors

```bash
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
- On your LAN: `http://<your-lan-ip>:5173` when the server binds to `0.0.0.0`

Vite proxies `/api` and `/collab` to the backend. Visiting `:8787` in dev redirects to Vite so you do not accidentally use a stale build.

`openleaf start` is the production-style entry for regular use. It serves the built editor from `client/dist` and does not launch Vite.

### Everyday commands

| Command | What it does |
|---------|----------------|
| `openleaf start` | Start this install and wait until `/api/health` succeeds |
| `openleaf stop` | Stop the process recorded for this install |
| `openleaf restart` | Stop, then start |
| `openleaf status` | URL, process, and health |
| `openleaf open` | Open the editor URL in a browser |
| `openleaf logs --follow` | Server log |
| `openleaf doctor` | Read-only checks. `--fix` only creates a missing projects directory or clears dead process metadata. `--smoke` compiles a throwaway file. `--json` prints the same checks. |
| `openleaf support-report` | Sanitized report you can paste into an assistant. It is not uploaded. |
| `openleaf account reset-password` | Set a new host password locally and sign out existing host sessions |

`openleaf stop` will not kill a process just because it holds the port. Passwords are prompted or generated; do not put them in the command line.

## Troubleshooting

### OpenLeaf won’t start

Run `openleaf doctor`. If it says the server or editor build is missing, run `npm run build`, then `openleaf start`. If it says the port is in use, pick another port in `config/local.json` or `OPENLEAF_PORT`. OpenLeaf does not stop the other program. If startup fails after the process spawns, run `openleaf logs`.

### The page won’t open

`openleaf status` prints the editor URL. For `openleaf start` that is the API port (default `http://127.0.0.1:8787`). During `npm run dev`, open the Vite port instead (default `http://127.0.0.1:5173`). A localhost install does not listen on your LAN address.

### My public link stopped working

A failed tunnel does not mean the local editor is down. Open the localhost URL from `openleaf status`. Then run `openleaf doctor` and read the `tunnel` check. Public links need `cloudflared` and `openleaf setup --access remote`. Quick Tunnel hostnames change when the process restarts. `openleaf restart` brings the tunnel back; guests need the new URL.

### LaTeX won’t compile

`openleaf doctor --smoke` compiles a temporary file and leaves your papers alone. Install the engine it names (`pdflatex` or `xelatex`) and `bibtex`. If the command exists but reports a missing format file, an earlier TeX install on `PATH` is broken; put the working TeX `bin` directory first. `latexmk` and `latexdiff` are optional: without `latexmk`, OpenLeaf still compiles; without `latexdiff`, track-changes PDFs are unavailable.

### I forgot my password

The host password is only for the public link. Localhost does not use it. From the machine that runs OpenLeaf:

```text
node cli/bin/openleaf.js account reset-password
```

That is the same command in Windows PowerShell and macOS Terminal.

Use `--generate` to write a new password into `config/host-credentials.txt`, or `--password-stdin` to provide one without putting it in the process arguments. Existing host sessions stop working. This does not change collaboration names inside papers.

## First-time usage

1. After `openleaf setup`, open the editor URL it prints. You will see **Projects**.
2. Open **openleaf-welcome** (the sample setup compiles) or create a new project. **example-article** remains in the repository as a template; **New from example** copies it.
3. Edit LaTeX in the Monaco editor. **Ctrl/Cmd+S** saves to disk and (by default) auto-compiles.
4. Use **Recompile** for a manual build; watch the log and PDF panes.
5. Download **PDF** or **ZIP** from the toolbar when needed.

### Toolbar cheat sheet

| Control | What it does |
|---------|----------------|
| **You** dropdown | Pick your collab identity for this project (from `openleaf.json`) |
| Theme toggle | Light / dark (default is dark; preference stored in the browser) |
| **History** | Per-project git snapshots; restore a previous save; **Highlight since** marks later additions on the PDF |
| **Comments** | Source-anchored review threads (`comments.json`); Shift+click PDF or Ctrl/Cmd+Alt+M in source |
| **Save & sync** | Flush live collab edits to disk and commit a backup |
| **Recompile** | Run the TeX engine |
| **PDF** / **ZIP** | Download outputs |
| **Download track-changes PDF** | `latexdiff` PDF of the compare baseline vs this checkpoint (needs `latexdiff` on the host) |
| **Markup PDF** (experimental) | Same `latexdiff` PDF in the preview pane, instead of SyncTeX addition boxes |

### Collaboration

- Identities are **per project**, listed in `projects/<id>/openleaf.json` under `identities`.
- New projects are seeded from your display name in `config/local.json` (`user.displayName` and `defaultIdentities`). That name is not the host login. Papers already on disk keep the identities in their own `openleaf.json`.
- Open the same project in two browsers, pick different identities, and edit — changes sync over WebSocket (`/collab/<project>`).
- Presence chips in the toolbar show who is connected.

### Version history

Each project gets its own git repo under `projects/<id>/` (ignored by the OpenLeaf repo’s `.gitignore`). Explicit saves and file-tree mutations auto-commit; background collab flushes do not. Use **History** in the UI to browse and restore. Disable with `"git": { "enabled": false }` in config.

**Highlight additions** (PDF toolbar) diffs manuscript `.tex` files against a chosen snapshot and paints those added lines on the preview via SyncTeX — the same yellow you’d get from `\hl{...}`, without wrapping source. Toggle off for a clean view; the downloaded PDF is unchanged. Pick a baseline from the dropdown or **Highlight since** in History. `misc/` notes are ignored. Recompile after edits so SyncTeX boxes match the current PDF.

**Markup PDF** (experimental toggle, shown when Differences is on) replaces that overlay with the same `latexdiff` track-changes PDF you can download. Uncommitted editor edits are not included. Click-to-source still uses the live (or checkpoint) SyncTeX map, so jumps stay on the raw project files; they can be a little off if markup changed pagination.

**Download track-changes PDF** (overflow menu) runs `latexdiff` on the compare baseline vs this checkpoint and compiles a marked-up PDF. Uncommitted editor edits are not included. The host must have `latexdiff` installed.

## Project layout

```
projects/my-paper/
  main.tex
  metrics.tex       # optional shared number macros (\input{metrics})
  references.bib
  openleaf.json     # mainFile, engine, identities[]
  comments.json     # review threads (author, file:line, replies); git-tracked
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
| `OPENLEAF_HOST` | Bind address. `openleaf setup` writes `127.0.0.1` for a new install. The shipped file default, used only when nothing else is set, is `0.0.0.0`. |
| `OPENLEAF_PORT` | API port (default `8787`); Vite proxies `/api` and `/collab` here in dev |
| `OPENLEAF_CLIENT_PORT` | Vite UI port in `npm run dev` (default `5173`) |
| `OPENLEAF_PROJECTS_ROOT` | Projects directory (relative to repo root, or absolute) |
| `OPENLEAF_LIBRARY_ROOT` | Citation library directory (default `./library`; sibling of projects) |
| `OPENLEAF_ENGINE` | `pdflatex` or `xelatex` |
| `OPENLEAF_DISPLAY_NAME` | Collaboration display name for this process. Not the host login. |
| `OPENLEAF_HOST_GATEWAY` | Set to `0` to keep the public tunnel off. Setup writes `access` so `openleaf start` does this for localhost and LAN. |
| `OPENLEAF_CONFIG_DIR` | Alternate config directory |
| `OPENLEAF_REPO_ROOT` | Alternate install root |

New installs from `openleaf setup` bind to `127.0.0.1`. An existing `config/local.json` keeps its host unless you pass `--access`.

Collaboration identities for **new** projects come from your display name (`user.displayName` / `defaultIdentities` in `config/local.json`). They are not the host login (`user.hostUsername`, default `host` when nothing else was chosen). Papers already on disk keep the identities stored in their `openleaf.json`.

You can also `GET` / `PATCH /api/config` (PATCH writes `config/local.json`).

**Separate papers from the app clone:** point `OPENLEAF_PROJECTS_ROOT` (or `"projectsRoot"` in `config/local.json`) at any writable directory, e.g. `/home/you/papers`. New projects are created there instead of `./projects/`.

**Second instance on a shared machine** (ports already taken):

```bash
OPENLEAF_PORT=8788 OPENLEAF_CLIENT_PORT=5176 OPENLEAF_PROJECTS_ROOT=/path/to/papers npm run dev
```

Then open `http://127.0.0.1:5176`.

## Features

- Full project filesystem: create / rename / delete / upload any path under the project
- Monaco LaTeX editing with SyncTeX (click PDF → jump to source)
- Auto-compile on save, compile logs, PDF.js preview, resizable panes
- Realtime multi-user editing (Yjs) with preset identities
- Per-project git backups, History UI, and PDF overlays for manuscript lines added since a snapshot
- Light / dark theme
- Download PDF or project ZIP (excludes `.openleaf/`); optional track-changes PDF via `latexdiff`
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

New `trycloudflare.com` hostnames often take 30–90 s (sometimes a couple of minutes) to appear in public DNS. The share panel waits for that and shows **Public DNS is ready** before you should send the link. If a guest already hit `ERR_NAME_NOT_RESOLVED` on Windows, have them wait a minute or run `ipconfig /flushdns`, then retry — negative DNS answers are cached.

## Security note

OpenLeaf is meant for trusted local or LAN use. On the local port there is **no authentication**: anyone who can reach the host directly can read and write project files and trigger compiles. Do not port-forward it; use the Share feature above (which adds sign-in, project scoping and limits) when someone remote needs access, and only give the credentials to people you trust — a guest with write access can still put arbitrary files into the shared project and run `latexmk` on your machine.

**OpenLeaf contributors are not responsible for the security, privacy, or integrity of your data.** Public Share links, AI collaborator tokens, host-gateway tunnels, and anything a guest or external model does with access you grant are your responsibility. Before creating a public Share or AI link, the UI requires you to check an acknowledgment of these risks. See [SECURITY.md](SECURITY.md) for the full disclaimer and secret-handling guidance.

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
