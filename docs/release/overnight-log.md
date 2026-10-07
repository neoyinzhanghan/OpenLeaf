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

## 2026-09-28T16:00Z — macOS CI

- Actions run 36402259761: `test (ubuntu-latest)` passed. `test (macos-latest)` failed 4 server tests, CLI 19 passed.
- Each failure was `spawn pdflatex ENOENT`. The workflow installs TeX only on Ubuntu.
- Compile-safety and historical-checkpoint tests now skip when `pdflatex` is missing. The latexmkrc case also skips when `latexmk` is missing, so a pdflatex fallback cannot count as proof that project rc files stay off.
- Track-changes compile cases already skipped without latexdiff.

## 2026-09-29T09:50Z — night 2, P0 fixes pushed

- Tip before this night's commits: `82c3745`.
- `5e151ad` keeps both editors' text, treats an unchanged PDF as success, confines machine settings to the loopback owner, makes pairing a POST with a nonce, and shows the sign-in page to an unpaired LAN visitor.
- Red runs before those fixes, then green after:
  - Two `y-websocket` clients: sync timed out around 8s, `synced` stayed false. After the message buffer, they converge.
  - Second compile after the PDF was aged 10 seconds: `ok` false, log ended with "Latexmk: Nothing to do". After the log-and-file rule, `ok` and `upToDate` are true.
  - Paired device PATCH of a protected key returned 200. After the loopback guard, 403. Pairing GET returned 302. After the confirmation page, 200. Unpaired `/me` was `host`. After the lane check, `host-login`.
  - Forged `X-Forwarded-For` through a stand-in on `127.0.0.2` with `localAddress` set returned 200. After the last-hop rule, 401.
  - Tex log dedupe: 2 !== 1. `defaultFile`: null !== `main.tex`.
  - A device revoked 100 days ago was still listed. After the 90-day prune, it is gone.
- The installer behavior change did not have its own red run that night. The red run is below.
- Stash `stash@{0}` was not applied, popped, or dropped. Port 8787 pid 284922 was not restarted.

## 2026-09-29T09:52Z — CI run 36552003573 on `5e151ad` failed

- Ubuntu: server 203 pass, 4 skip, 0 fail. CLI "installs the openleaf command" `false !== true` at `cli.test.ts:66`.
- macOS: that same installer failure, plus `listen EADDRNOTAVAIL: address not available 127.0.0.2`, plus status exit 1 ("not this OpenLeaf install").
- Fresh clone of `5e151ad` on this machine: installer 1, server 207 pass / 0 skip, CLI 23 pass / 0 skip, e2e 18 passed. `setup` exit 3 because port 8787 is taken. Global `openleaf` unchanged.

## 2026-09-29T10:02Z — installer and macOS listener

- Red: `CI=1` with `OPENLEAF_BIN_DIR` set to an empty temp directory. The script exited 0 and created no symlink. Cause: every `CI` process returned immediately, including an explicit install. GitHub Actions sets `CI` for `npm test`.
- Green after: the same command creates the symlink. `CI=1` and `npm_lifecycle_event=postinstall` still creates nothing.
- macOS listener lookup is `lsof -nP -iTCP:PORT -sTCP:LISTEN -t`. The proxy test binds `127.0.0.2` when that address exists.
- Commit `bc42f0b`.

## 2026-09-29T10:03Z — CI run 36553071615 on `bc42f0b`

- macOS unit tests got past the listener. Status printed a healthy process and port, then exited 1. Cause: a missing `pdflatex` is an error, and status did not print that check. Ubuntu on this run was still going when the next commit was pushed.

## 2026-09-29T10:07Z — status exit matches the lines it prints

- `openleaf status` now exits from process, port, API, app, and tunnel. `openleaf doctor` still reports a missing engine.
- Local proof: the checkout-server test passed with `PATH` set to a directory that does not contain `pdflatex`.
- Commit `fed77e7`. Fresh clone fast-forwarded to that SHA and `npm run e2e` passed again (18, 36.0s).
- CI run 36553599677 on `fed77e7`: macOS passed. Ubuntu e2e failed two tests. The example uses `booktabs`, which is not in `texlive-latex-base`, so compile returned 422, the PDF download was 404, and the editor pill stayed "Error". The collab test was waiting on that pill.
- `54cccb1` installs `texlive-latex-recommended` on Ubuntu, waits for the collab sync flag, and requires compile HTTP 200 before the PDF download.
- CI run 36554366160 on `54cccb1` is green. Ubuntu ran e2e. macOS ran unit tests and build, and skipped e2e and TeX.

