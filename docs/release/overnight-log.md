# Overnight log — release/ship-ready

Started from `origin/feature/citation-library` at `4d3ba93`.
Neo's dirty working tree on `feature/citation-library` was stashed as `wip on citation-library before release/ship-ready (left untouched)` and was not included.
The live OpenLeaf on port 8787 was not stopped or edited.

## 2026-09-28T08:08Z — branch

- Created `release/ship-ready` from `origin/feature/citation-library`.
- Added `OVERNIGHT_SHIP_BRIEF.md` to `.git/info/exclude` (file is not in the repo).

## 2026-09-28T08:15Z — plan

Priority: P0 security and compile truth, then host access link, then discovery, then P1.
Isolated instances only (`OPENLEAF_PORT` not 8787, separate config and projects dirs).

## 2026-09-28T08:40Z — security core

- Commit `3b68003` `fix(security): confine compiles and require a device off loopback`.
- `-norc` by default, paranoid TeX file access, host allowlist, origin check, device sessions, compile `ok` from the log.
- Server unit tests for those paths passed before the commit.

## 2026-09-28T09:10Z — editor, phone link, CLI

- Bundled Monaco (editor API only) and self-hosted fonts. Undo after load does not clear `main.tex` (Playwright).
- Phone dialog on the project list and the editor menu. Pairing link redeemed once from a second browser context at a LAN address. Fake cloudflared shows a trycloudflare URL. No real tunnel was opened.
- Compile errors show a badge and an issue row.
- Project names slugify. New projects replace the template identity. Welcome project gets a git snapshot when git is available.
- Setup can set `--library-dir`. Doctor warns on Node 20, an in-checkout library, and `lanAuth: "open"`.
- Quoted the test glob. Server tests went from 148 to 196 because `server/src/services/library/**` had not been running.
- `npm audit fix` (no `--force`) reported 0 vulnerabilities afterward.
- Personal audit notes moved to `docs/audits/2026-09-15-quality-pass.md` with paper names and home paths removed. The two `.wsl-*.sh` scripts were deleted. History was not rewritten.

## 2026-09-28T09:20Z — verification

- `npm run typecheck` pass.
- `npm test`: server 196 pass, CLI 19 pass, 0 fail.
- `npm run build` pass.
- `npm run e2e`: 4 pass (undo, two-tab presence with an idle second tab, compile badge, phone link + fake tunnel).
- A second editor that types before it has the first editor's insert can still replace that insert on disk. Recorded under known issues. Exact markers are in `.cursor/private-notes.md` (not committed).
