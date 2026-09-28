# Ship readiness

**Verdict: READY WITH CAVEATS**

The branch `release/ship-ready` builds, typechecks, and passes the unit tests and the Playwright smoke that was actually run. A second person typing in the same file can still replace the first person's uncommitted insert. That is the caveat that keeps this from READY.

## Try it

```bash
git fetch origin release/ship-ready
git checkout release/ship-ready
npm ci
node cli/bin/openleaf.js setup --non-interactive --display-name "Your Name" --skip-start
node cli/bin/openleaf.js start
```

On the project list, choose **Open on your phone**. Same Wi-Fi is a one-time link. From anywhere starts a tunnel only after the risk checkbox. Existing `access=lan` installs must pair once; `lanAuth` defaults to `device`.

## Changes

Commits on `release/ship-ready`: `3b68003` (compile confinement and device auth) and `9016c5b` (phone pairing, bundled editor, CLI setup, recursive tests, and these docs).

## Findings

| Id | Severity | Status |
| --- | --- | --- |
| P0-1 latexmkrc, `.git`, `openin_any` | P0 | Fixed. Unit tests in `compiler.security.test.ts` and path-guard tests. |
| P0-2 CORS, Host, Origin, WebSocket | P0 | Fixed. `httpGuard.integration.test.ts`. |
| P0-3 two editors | P0 | Presence and an idle second tab keep the first edit (Playwright). A second tab that types can still drop the first insert. Open. |
| P0-4 Monaco CDN and undo wipe | P0 | Fixed in the Playwright undo test. Fonts are local. Bundle is the editor API plus the editor worker (about 3.3 MB plus pdf.js). |
| P0-5 compile `ok` | P0 | Fixed. Log parser tests and a Playwright badge. |
| P0-6 test runner / latexdiff order | P0 | Fixed. Track-changes checks hashes before latexdiff. Root `npm test` runs server and CLI. Nested library tests now run (196, was 148). |
| P0-7 LAN treated as owner | P0 | Fixed for the API. Vite binds `127.0.0.1` unless access is `lan` or `remote`, and proxies set `xfwd`. |
| P0-8 personal files | P0 | Scripts deleted. Audit doc moved and redacted. History still has the old files. |
| Host pairing link | P0 | Fixed and exercised with a second Playwright context and a fake cloudflared. |
| Template identity "Admin Neo" | P1 | Fixed. `createProject` always writes `defaultProjectIdentities()`. |
| Library inside the checkout | P1 | Setup uses a sibling `library` unless that checkout library already has papers. Doctor warns. |
| `npm audit` | P1 | `npm audit fix` without `--force`. `npm audit` then reported 0 vulnerabilities. |
| PDF zoom 120% | P1 | Default fit-width, remembered per project, always fit-width under 800px. |
| Project id pattern | P1 | Names slugify. Preview shown. |
| Focus trap in drawers | P2 | Not done. |
| Lazy-load pdf.js | P2 | Not done. pdf.js is still in the main bundle. |

## Flow sweep

Run on this WSL machine with Playwright Chromium. Desktop 1440×900. Phone context 390×844 for the pairing link.

| Flow | Result |
| --- | --- |
| Editor loads with jsDelivr and Google Fonts aborted | Pass |
| Undo after open does not empty `main.tex` | Pass |
| Two editors, presence, idle second tab keeps the first edit | Pass |
| Second editor types and both inserts remain | Fail (see known issues) |
| Undefined control sequence shows an error badge and an issue row | Pass |
| Same Wi-Fi pairing link, second context, link is single use | Pass |
| From anywhere with fake cloudflared shows the fake hostname | Pass |
| Local `git clone` of this branch into a temp directory, then `npm ci` and `npm run typecheck` | Pass. Full setup, start, and sample compile were not repeated in that directory. |
| Welcome compile, SyncTeX both ways, zip upload, comments, share guest, offline theme | Not run end to end in this pass |

## Discovery passes

| Pass | What was done | What it found |
| --- | --- | --- |
| Personas | Phone pairing and the editor were driven in Chromium here. macOS without TeX, Windows PowerShell, and a physical phone were not. | WSL defaults the phone dialog toward From anywhere. Same Wi-Fi still works when an address is selected. |
| Trust boundary | Host allowlist, origin check, loopback owner, device cookie, and collab upgrade are covered by unit and one HTTP integration test. | Bearer routes `/api/ai/` and `/api/library-ai/v1` skip the origin check and send reflected CORS without credentials. Other routes send no CORS. |
| Data safety | Welcome snapshot and snapshot-on-open are in the server. | Second-editor typing can replace the first insert. |
| Failure injection | Bad Host, bad Origin, project latexmkrc, `\input` of a file outside the project, undefined control sequence, missing latexdiff ordering. | Those paths return 421, 403, or `ok: false` as intended. Ctrl+C of a long-running `npm start` was not timed by hand. |
| State machines | Pairing single use, expiry, and rate limit are unit-tested. The browser reused a link and saw the expired page. | — |
| Error messages | Crossref failures now say to check the connection or paste BibTeX. | A full grep of every `throw` was not turned into copy edits. |
| Docs vs behavior | README quick start, phone pairing, and SECURITY.md match the new defaults. | Older README paragraphs still describe localhost as open to anyone who can reach the port. The new top section is the one to trust. |
| Cross-platform | GitHub Actions on `release/ship-ready`. Ubuntu installs TeX and runs the compile tests. macOS does not install TeX; those tests skip when `pdflatex` is absent. | Run 36402259761: ubuntu passed, macos failed four compile tests with `spawn pdflatex ENOENT`. |
| Console hygiene | Nested library tests, now that they run, print minted link URLs to the test log. | Pre-existing. Not changed. |
| Visual | Playwright at 1440×900 and 390×844 for the flows above. Light/dark of every screen was not reviewed. | Library header uses "Lit review" and "Add paper" so the two Review actions are not the same label. |
| Code smell | Test glob. | Unquoted `src/**/*.test.ts` skipped `server/src/services/library/**`. Quoted it. |

## Trust boundary

| Surface | Who |
| --- | --- |
| Loopback socket and loopback Host | Owner. No login. |
| Any other socket, including LAN | Device cookie, guest cookie, or bearer. `lanAuth: "open"` restores the old owner behavior and doctor warns. |
| `POST /api/host/pairings` and the other pairing admin routes | Loopback owner only. |
| `GET /host/pair/:token` | Public, single use, rate limited. Stores a hash, not the token. |
| Collab WebSocket | Same host and origin rules. Local lane needs the owner or a device cookie. |
| `/api/ai/` and `/api/library-ai/v1` | Bearer token. Reflected CORS, no cookies. |
| MCP | HTTP POST on the AI routes, not a second WebSocket upgrade. |
| Share `/join` and library share | Existing guest cookies. Unchanged this pass beyond the new host and origin checks. |

## Commands

| Command | Result |
| --- | --- |
| `npm run typecheck` | Pass (server, client, cli) |
| `npm test` | Pass. Server 196, CLI 19, 0 failed, 0 skipped |
| `npm run build` | Pass |
| `npm run e2e` | Pass. 4 tests |
| `npm audit` after `npm audit fix` | 0 vulnerabilities |
| Fresh clone rehearsal | Local clone, `npm ci`, and `npm run typecheck` passed. Setup and sample compile were not repeated there. |

## Decisions for Neo

- `lanAuth` defaults to `device`. `"open"` is opt-in.
- Project latexmkrc stays off unless `latex.allowProjectLatexmkrc`, and stays off while a share or live AI link exists.
- `latex.paranoidFileAccess` defaults to true. Compiles never pass `-shell-escape`. `latexmk -f` remains so a PDF can still be produced; `ok` is false when the log has errors.
- PDF mtime may be up to 2 seconds older than the compile start, because some filesystems are coarse.
- The public tunnel starts only when access is `remote`, or when someone chooses From anywhere. `stopHostGateway` leaves the process marked stopping so the exit handler does not immediately start it again. The next explicit start clears that flag.
- v1 host cookies are rejected. Password login creates a device. Reset password revokes devices and rotates the secret.
- `Secure` is set only on https.
- If the main server is already bound to `0.0.0.0`, a second listen on the same port is treated as already reachable.
- `config/default.json` still says `host: "0.0.0.0"`. Setup writes `127.0.0.1` for a localhost install. Device auth applies either way.
- Dev phone links use the Vite port. Vite on a localhost install binds `127.0.0.1`, so a phone cannot load the dev UI. Production `openleaf start` is the phone path that was tested.
- `OPENLEAF_TUNNEL_SKIP_DNS=1` makes the DNS probe succeed. It exists so tests can use a fake cloudflared. Leave it unset in real use.
- Monaco undo is cleared through the private command manager because this Monaco build has no public clear-undo API.
- The citation-library stash `wip on citation-library before release/ship-ready (left untouched)` was not applied.

## Known issues

- Two editors: the second person to type can replace the first person's insert on disk. An idle second tab does not. Details are in `.cursor/private-notes.md`, which is not in git.
- Drawer focus traps and code-splitting pdf.js are not done.
- macOS CI does not install TeX. Compile tests that need `pdflatex` skip there. Ubuntu still runs them.

## Only Neo can do these

- Older commits still contain `.wsl-inspect-projects.sh`, `.wsl-list-projects.sh`, and `OPENLEAF_OVERNIGHT_AUDIT.md`. Tell Neo so he can decide whether that matters. This pass did not rewrite history.
- Apply or drop the stash on `feature/citation-library` when he wants that work back.
- Existing `access=lan` installs must pair once after this upgrade.
- Confirm a physical phone on his Wi-Fi, and a real cloudflared install, before calling the phone path done outside this sandbox.
