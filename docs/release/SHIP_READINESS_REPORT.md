# Ship readiness

**Verdict: READY**

P0-1 through P0-5 are fixed at the causes below. A fresh clone passed `npm run e2e` (18 tests) on this machine, and GitHub Actions run [36554366160](https://github.com/neoyinzhanghan/OpenLeaf/actions/runs/36554366160) on `54cccb1` is green: Ubuntu ran typecheck, unit tests, build, and e2e; macOS ran typecheck, unit tests, and build. macOS does not install TeX and does not run e2e, so compile cases there are skips.

Branch `release/ship-ready`. The green code tip is `54cccb1`. Base for a pull request remains `feature/citation-library`.

## Evidence

Fresh clone: `/tmp/tmp.o7HwUWuYVc`, `git clone -b release/ship-ready` at `bc42f0b`, then fast-forward to `fed77e7` for the full e2e list below. `54cccb1` is that tree plus the Ubuntu TeX package and the collab sync wait; those two e2e cases were re-run locally and the full suite ran in CI. `npm ci` used `OPENLEAF_BIN_DIR` and `HOME` inside that sandbox. `git status --porcelain` was empty. Neo's `~/.local/bin/openleaf` and the nvm `openleaf` symlink still point at `/home/yinzh/Projects/OpenLeaf/cli/bin/openleaf.js`. The process on port 8787 (pid 284922) was still listening after setup, tests, doctor, and stop.

`npm run e2e` in that clone set `PLAYWRIGHT_BROWSERS_PATH=/home/yinzh/.cache/ms-playwright` because `HOME` was the sandbox and would not see the existing browser cache.

| Claim | Command or test | Fresh clone? | CI? |
| --- | --- | --- | --- |
| Install leaves the tree clean and does not move Neo's `openleaf` | `OPENLEAF_BIN_DIR` + `HOME` sandbox, `npm ci`, `git status --porcelain` | Yes, `bc42f0b` | Yes. `npm ci` in run 36554366160 |
| Typecheck | `npm run typecheck` exit 0 | Yes, `fed77e7` | Yes, both jobs in run 36554366160 |
| Unit tests | Installer 1 pass. Server 207 pass, 0 fail, 0 skip. CLI 24 pass, 0 fail, 0 skip (16 command tests + 8 platform tests) | Yes, `fed77e7` | Yes, both jobs in run 36554366160. macOS skips compile cases when `pdflatex` is missing; that is a skip, not a pass |
| Production build | `npm run build` exit 0. Main chunk about 2.98 MB. `PdfViewer` chunk about 381 kB | Yes, `fed77e7` | Yes, both jobs in run 36554366160 |
| Browser flows | `npm run e2e`: 18 passed (36.0s) on `fed77e7`. The collab sync wait and compile-200 download check passed locally on `54cccb1` | Yes | Yes. Ubuntu e2e in run 36554366160. macOS does not run e2e |
| Setup refuses to take a busy port | `setup --non-interactive --display-name "Test User" --skip-open` exit 3. Message: port 8787 is already in use and OpenLeaf will not stop it. Library and sample project were created under the sandbox home | Yes | Not a CI step |
| Doctor on a sandbox whose config port is 8787 | Exit 1. It reports the port is held by another program, and it also reports API health at `http://127.0.0.1:8787` because that is the live server. `tex-smoke` skipped (not requested). `tunnel` skipped (public sharing off) | Yes | Not a CI step |
| Stop with no instance file | `openleaf stop` exit 0: "OpenLeaf is not running (no instance metadata)." | Yes | Not a CI step |

## Findings

| ID | Severity | Root cause | Fix | Test | Failed before fix? |
| --- | --- | --- | --- | --- | --- |
| P0-1 | P0 | The collab socket handler awaited room open before attaching the message listener. The client's sync step 1 was emitted in the same turn and dropped, so the server never sent the document. | Buffer messages that arrive while the room opens, then drain them after the document listener and sync step 1 are installed. The Monaco stale-index heuristic and the post-edit `setValue` were removed. | `server/src/services/collab/twoClient.convergence.test.ts`. Playwright `e2e/collab.spec.ts`: both orders, concurrent different lines, disk edit while both tabs are open. Both markers on disk and in both `Y.Text` docs. | Yes. Headless clients connected and `synced` never became true (about 8s). |
| P0-2 | P0 | A successful compile required the PDF mtime to be within 2 seconds. latexmk "Nothing to do" does not rewrite an up-to-date PDF. | Success is exit 0, no errors in the log, and a PDF on disk. `upToDate` is that success when the PDF was not rewritten. A previous failed log still counts as an error. | `compiler.uptodate.test.ts` ages the PDF by 10 seconds. Playwright recompile shows no Error badge and no "Showing the last successful PDF". | Yes. Second compile was `ok: false` with "Latexmk: Nothing to do" after the PDF was aged. An immediate second compile inside the 2 second window was a false pass and was not used. |
| P0-3 | P0 | A paired device could `PATCH` machine settings. | Loopback owner only for `lanAuth`, `allowedHosts`, `access`, `host`, `port`, `projectsRoot`, `libraryRoot`, `latex.allowProjectLatexmkrc`, `latex.paranoidFileAccess`, and `git.*`. | `hostAccess.p0.test.ts`: paired device 403 on each protected key, 200 on `user.displayName`. Loopback can still change them. | Yes. Protected PATCH returned 200. |
| P0-4 | P0 | `GET /host/pair/:token` redeemed the link. | GET returns a confirmation page and a one-time nonce. POST redeems only when the Origin host matches the Host header and the nonce matches. Nonce is deleted only after that check. 10 minute expiry and single use stay. | `hostAccess.p0.test.ts`. | Yes. GET returned 302. |
| P0-5 | P0 | An unpaired LAN request was treated as the owner in the client session. | Guest `/me` on the local lane returns host-login when the socket is not the loopback owner, there is no device cookie, and `lanAuth` is not `open`. A 401 `HOST_AUTH` refreshes the session and the app shows the sign-in page. "Open on your phone" stays off for a remote host session. | `hostAccess.p0.test.ts`. Playwright: unpaired `127.0.0.2` shows "Sign in to OpenLeaf"; password login reaches Projects; after revoke-all, reload shows the login page. | Yes. `/me` mode was `host`. |
| P1-1 | P1 | Dev-mode forwarding trusted the first `X-Forwarded-For` hop, so a client could claim to be loopback. | Trust the last hop only. Honour `cf-connecting-ip` only when Host is a `*.trycloudflare.com` name. The Vite proxy strips incoming forwarded headers and sets `X-Forwarded-For` from the socket peer. | `requestGuard.proxy.test.ts`. Binds `127.0.0.2` when that address exists, otherwise a non-internal IPv4, and connects from that address. | Yes. Forged first hop returned 200 before the last-hop rule. The first attempt without `localAddress` was a bad red (the peer stayed `127.0.0.1`). macOS CI then failed with `EADDRNOTAVAIL` on `127.0.0.2` because that alias does not exist there; the test now binds an address the machine actually has. |
| P1-2 | P1 | `e2e/fake-cloudflared.sh` was mode 100644, so a fresh clone could not spawn it, and CI did not run e2e. | Git index mode 100755, and shell scripts are spawned with `sh`. Ubuntu CI installs Playwright Chromium and runs `npm run e2e`, and uploads traces on failure. | Fresh-clone `npm run e2e`, 18 passed. | The mode bug was observed on a fresh clone in the night-1 review. This night's first CI run of the e2e job never reached e2e because unit tests failed first (run 36552003573). |
| P1-3 | P1 | Personal project names remained in scripts and a CLI fixture. | Those names were removed from the current tree. History was not rewritten. | Repo search of the current tree for those names returned no matches. | The names were present before the edit. A dedicated failing test was not added. |
| P1-4 | P1 | `npm ci` postinstall repointed a global `openleaf` and could edit a shell rc. A later check treated every `CI=1` process as that postinstall, so an explicit install on GitHub Actions created nothing and exited 0. | Postinstall skips shell rc unless `--add-to-path`. It does not repoint another checkout unless `--force`. The silent skip is only `OPENLEAF_SKIP_BIN=1`, or `CI` together with `npm_lifecycle_event=postinstall`. | `cli.test.ts` "installs the openleaf command". Before the fix, `CI=1` left the bin directory empty. After, the symlink is created, and `CI=1` plus `npm_lifecycle_event=postinstall` still leaves it empty. | Yes, on 2026-09-29: explicit `CI=1` install, exit 0, empty directory. GitHub run 36552003573: `false !== true` at `cli.test.ts:66` on Ubuntu and macOS. |
| P1-5 | P1 | Compile issues were duplicated, and a missing file fell back to null. The badge matched more than one control. | Dedupe by severity, file, line, and message. Default file is the project main file. Badge text is "N error" / "N errors". | `texLog.test.ts`. Playwright looks for the button named "1 error". | Yes for the duplicate count (2 !== 1) and for `defaultFile` (null !== `main.tex`). Input-file attribution already passed before that change. |
| P1-6 | P1 | README still described an editor with no authentication. | README, SECURITY.md, config README, and CLI help describe loopback owner, pairing, and the tunnel password. | CLI help test expects `install-cli`, `uninstall-cli`, and "host password". | The old help text was what the test used to assert. The assertion was updated with the copy, so this was not a separate red run. |
| P1-7 | P1 | On a narrow screen, `flex-basis: 220px` on a column became the input height. | The mobile rule sets height auto, width 100%, min-height 44px. Library density reads "Compact" / "Comfortable". | CSS review. Screenshots of every screen were not taken. | Seen in the night-1 review at 390×844. No new automated red test. |
| CI status on macOS | P1 | `checkoutServerPid` only read Linux `/proc`. macOS then treated a checkout server as a stranger. After `lsof` was added, status still exited 1 because a missing TeX engine is an error, and status did not print that check. | macOS asks `lsof` for the listener pid. Windows asks `Get-NetTCPConnection`. `openleaf status` exits from the checks it prints (process, port, API, app, tunnel). `openleaf doctor` still fails when the TeX engine is missing. | `platform.test.ts` asserts the `lsof` and PowerShell arguments. `cli.test.ts` "recognizes a checkout server" passed locally with `PATH` containing no `pdflatex`. | Yes. Run 36552003573: `listen EADDRNOTAVAIL 127.0.0.2` and status exit 1 ("not this OpenLeaf install"). Run 36553071615 on `bc42f0b`: process and port were ok, then `1 !== 0` because TeX was missing and not printed. |
| P2 focus | P2 | Drawers did not trap Tab. | Focus trap is on the phone-access dialog only. | Manual review of `useFocusTrap`. Other drawers were not given a trap. | No red test. |
| P2 pdf.js | P2 | pdf.js was in the main bundle. | `PdfViewer` is loaded with `React.lazy` from the editor and the library notes. | Build output lists `PdfViewer-*.js`. | No red test. The main chunk is still about 2.98 MB. |
| P2 devices | P2 | Revoked devices were kept forever and the JSON file was read on every request. | Revocations older than 90 days are dropped on load. The list is cached by path and mtime. | `hostDevices.prune.test.ts`. | Yes. A device revoked 100 days ago was still present. |
| P2 hostname | P2 | `OPENLEAF_HOST_PUBLIC_HOSTNAME` was not on the Host allowlist. | It is added automatically, port stripped. | Documented in SECURITY.md and config/README.md. | No separate red test this night. |

## Flows in §5

Run with Playwright on the fresh clone of `fed77e7` (18 passed). Viewport was the Playwright default for the API flows. Phone pairing uses a second context. These are not per-viewport visual passes.

| Flow | Result |
| --- | --- |
| Share guest, fake cloudflared: write link, sign in, edit, compile, 403 on `latexmkrc`, `.latexmkrc`, `.git/config`, `openleaf.json`, `comments.json` via PUT, fs create, mkdir, and rename; 403 on projects, config, and library; kick; stop | Pass. `e2e/flows.spec.ts`. Fresh clone. A separate read-only link, upload, and merge were not run. |
| SyncTeX forward, ZIP download, PDF download | Pass. Same file. Reverse SyncTeX and image upload were not run. |
| Timeline commit, fork, checkout, merge start, track-changes | Pass. latexdiff is installed on this machine, so the "latexdiff is not installed" branch was not hit. Restore, highlight-since, and a conflict editor were not run. |
| Comments add, reply, resolve | Pass, through the API. Shift+click on the PDF and guest author-only edit/delete were not run in the browser. |
| Library BibTeX import, offline link error, export by the returned cite key | Pass. PDF drop, annotations, collections, tags, star, rating, cite completion, hover cards, claim-check, library share, and library AI were not run. |
| Project AI link mint and revoke | Pass. "A guest revokes only their own link" is a unit test, not this browser flow. |
| Host "From anywhere" shows `fake-words-here.trycloudflare.com` | Pass. Pairing through that tunnel host with `cf-connecting-ip`, then revoke and stop, was not run. |
| 10 MB `.tex` saved and the size checked on disk | Pass. Empty `PATH` compile, read-only projects directory, server restart with two tabs, and a dropped WebSocket were not run. Port-in-use is the CLI test that refuses to kill another process. |
| macOS and Windows command lines | Pass in `platform.test.ts` (argument checks, not a live Mac or Windows). A physical phone was not used. |

## Discovery passes

| Pass | What was done | What it found |
| --- | --- | --- |
| Personas | CLI platform tests and the macOS CI logs. | macOS has no `127.0.0.2` and no `/proc` socket table. A missing TeX engine made `openleaf status` exit 1 while printing a healthy editor. |
| Trust boundaries | Paired-device PATCH, pairing GET, last forwarded hop, guest write guards in the share flow. | P0-3, P0-4, P1-1. A route-by-route stolen-cookie review of every endpoint was not written up as its own pass. |
| Data safety | Current-tree search for the private project names. Installer sandbox. | Names removed from the current tree. Older commits still contain them. `npm ci` in the sandbox did not move Neo's symlink. |
| Failure injection | Aged PDF, 10 MB file, busy port 8787 during setup, CLI test that a foreign pid is left alive. | P0-2. Setup exit 3. The two-tab restart and mid-typing socket drop were not run. |
| State machines | Pairing nonce, single-use phone link, revoke reload. | GET does not redeem. A second redeem from a fresh context shows the used-link page. |
| Error messages | Compile badge "1 error". Status vs doctor. | Status used to exit 1 for a check it did not print. |
| Docs vs behavior | README, SECURITY.md, config README, CLI help. | The "no authentication" lines were rewritten. The ship report from night 1 was still the old caveat text until this rewrite. |
| Cross-platform | Ubuntu and macOS Actions logs, plus the platform unit tests. | Installer `CI` skip, `lsof`, and the status exit. Windows was not executed. |
| Console hygiene | Not a full browser console sweep this night. | No new finding recorded. |
| Visual | Phone CSS for the 220px input. Density labels. | Screenshots at 390×844 and 1440×900 were not taken this night. |
| Code smells | Collab message buffer, pdf.js split, device cache. | The stale Monaco heuristic was deleted. Focus traps remain only on the phone dialog. |

## Decisions for Neo

- macOS CI does not install TeX. Compile tests skip there. Ubuntu installs `texlive-latex-base`, `texlive-bibtex-extra`, and `latexmk`. It does not install `latexdiff`.
- Server tests use `tsx --test --test-force-exit` so a WebSocket or file watch cannot hang the run.
- Pairing confirmation is a POST with a one-time nonce. GET only shows the page.
- The last `X-Forwarded-For` hop is the client. `cf-connecting-ip` is read only for a `*.trycloudflare.com` Host.
- `npm ci` on CI skips the command install only during the postinstall lifecycle. `openleaf install-cli` still installs. `--add-to-path` and `--force` stay explicit. `OPENLEAF_SKIP_BIN=1` skips.
- End-to-end LAN uses `127.0.0.2` via `OPENLEAF_E2E_LAN_ADDRESS` when that address exists.
- `OPENLEAF_HOST_PUBLIC_HOSTNAME` is added to the Host allowlist.
- Revoked devices older than 90 days are removed from `host-devices.json`.
- `window.__openleafCollabDebug` is off unless the dev build is running or the page sets `__openleafWantCollabDebug` before load. The e2e suite sets that flag because it serves `client/dist`.
- A sandboxed `HOME` does not see the Playwright browser cache. The rehearsal set `PLAYWRIGHT_BROWSERS_PATH`.
- If port 8787 is taken, setup exits 3 and does not kill the other process.
- `openleaf status` exits from process, port, API, app, and tunnel. A missing TeX engine is `openleaf doctor`.
- macOS finds the listening pid with `/usr/sbin/lsof`. Windows uses `Get-NetTCPConnection`.

## Only Neo can do these

- The stash `stash@{0}` on `feature/citation-library`: `wip on citation-library before release/ship-ready (left untouched)`. It was not applied, popped, or dropped.
- Older commits still contain personal project names. History was not rewritten.
- Pair a physical phone, and try a real cloudflared tunnel.
- Decide whether to rewrite history.

## Two-minute check

```bash
git fetch origin release/ship-ready
git checkout release/ship-ready
git stash list
```

The stash line above should still be there.

```bash
node cli/bin/openleaf.js status
```

Then in the browser: open a project in two windows, type a different word in each, and confirm both words stay. Recompile a project you just compiled and confirm there is no Error badge. On the project list, open **Open on your phone** and confirm the QR caption says a pasted link may not preview.
