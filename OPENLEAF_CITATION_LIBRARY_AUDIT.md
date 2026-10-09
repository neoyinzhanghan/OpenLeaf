# OpenLeaf citation-library overnight quality audit

Date: 2026-09-30
Branch: `audit/citation-library-quality-pass` (from `feature/citation-library` @ `4d3ba93`, which fast-forwards cleanly onto `main` @ `b1daef7`)
Auditor: autonomous overnight pass
Scope: the new citation/paper-management library feature only (`server/src/services/library/**`, `server/src/routes/library*.ts`, `server/src/services/libraryAi*.ts`, `server/src/services/libraryShare.ts`, `client/src/components/Library*.tsx`, plus the citation-related bits of `cli/src/`). The pre-existing editor/collab/share surface audited on 2026-09-15 (`OPENLEAF_OVERNIGHT_AUDIT.md`) was not re-reviewed.

Fixes were made directly against the checked-out branch and committed locally (commit `ed6ccf6`). **This session's GitHub access does not include push rights for this repo**, so no branch was pushed and no PR was opened — apply the commit yourself (see §6).

## 1. Executive summary

The citation-library feature (personal paper library, DOI/arXiv/URL/PDF/BibTeX import, an FTS-indexed search, citation-integrity + retraction checks, LLM claim-support checking, PDF annotation, and two MCP surfaces — a no-auth host-local one and a Bearer-token one for external AI agents) was built out fully on `feature/citation-library` per the spec from an earlier session. This pass audited it end to end: path/authz boundaries, the two MCP/AI surfaces, the retraction/integrity pipeline, PDF handling, BibTeX escaping, and the new client UI (drawers, annotator, keyboard handling).

Highest-impact findings, all fixed:

- A crafted citekey could path-traverse out of `library/papers/` through every downstream helper (`recordPath`, `annotationsPath`, `attachmentPath`) — none of them validated the citekey themselves, they all trusted `paperDir()`.
- The claim-support cache used two different hash formulas in the write path vs. the verify path, so a `library_verify` call could return a stale cached verdict for a citing sentence that had since changed at the same `file:line:citekey` — a silently wrong "supported" verdict.
- `verifyProposal`'s pre-add retraction check was a stub that returned `"clean"` on every branch, including a genuine Crossref outage — so a broken network silently reported an unretracted paper as checked-and-safe instead of failing closed. The real post-add check (`checkPaperIntegrity`) already existed; the pre-add gate just never called it.
- The Bearer-token AI surface's `/lookup` and `/verify` endpoints (REST and MCP) were missing the `allowSearch` gate that `/search`, `/recent`, and `/papers/:citekey` already had, letting an AI link minted without search permission still originate outbound network lookups.
- Minted library-share and library-AI invite URLs (which embed the session's credential) were logged to the server console in full.
- `citations.json` (claim-support instances, git-tracked per project) was missing from the guest-forbidden-write list that already covers `comments.json`, so a read-write guest could tamper with citation claim records.
- A PDF download (`fetchAndAttachPdf`, used for both arXiv and Unpaywall open-access fetches) had no size cap or timeout — a large or slow/stalled response could exhaust memory or hang a request indefinitely.
- BibTeX export only escaped `{`, `}`, and `\`; a title or author containing `&`, `%`, `$`, `#`, `_`, `~`, or `^` produced BibTeX that breaks LaTeX compilation for anyone citing that paper. A citekey was also interpolated unescaped into a `RegExp` used to resync the `.bib` file.
- The three new client dialogs (share, AI-link, AI-review) were missing the `.history-drawer` class that actually supplies `position: fixed` — their own CSS classes only set width/z-index. They rendered inline instead of as overlays, and even once fixed, their z-index (40) sat below the Library panel that hosts them (42), so they'd paint behind it.

Also fixed: a stale-draft bug in the PDF annotator (switching tools or drawing a new mark left a previous edit's text sitting in the composer for the next annotation), a race where an in-flight annotation refresh for a previously-viewed paper could clobber the currently-viewed paper's list, a `trackChanges` error-precedence bug inherited from the base branch, a lookup-cache filename collision, a malformed `?limit=` query param silently returning zero results instead of the default page size, several missing `aria-label`s, and a path-redaction gap in the CLI's support-report sanitizer.

Automated tests: server **184 pass / 0 fail** (4 pre-existing skips — `latexdiff` not installed in this sandbox, unrelated to this pass), CLI **21 pass / 0 fail**. `npm run typecheck` and `npm run build` are clean across all three workspaces (server, client, CLI).

## 2. Method

- Read `AGENTS.md`, the prior audit report, and the full citation-library source tree (routes, services, MCP handlers, client components, styles).
- Traced every path that turns user/AI input into a filesystem path, a shell-adjacent operation (BibTeX regex sync), or an outbound network call.
- Compared the two MCP surfaces (`library/libraryMcp.ts`, host-local/no-auth by design, vs. `libraryAiMcp.ts`, Bearer-token-gated) against their REST counterparts for parity in auth checks.
- Read the claim-support and integrity pipelines closely enough to hand-derive the cache-key formulas used on the write path vs. the read/verify path.
- Read the three new client drawer components and their CSS against the established `.history-drawer` pattern used by the existing comments/timeline drawers.
- Fixed everything Critical/High, plus Medium/Low items that were a small, well-contained change; documented the rest as deferred (§4).
- Verified via the existing `node:test` suite (extended with new regression tests for nearly every fix), `tsc --noEmit`, and `vite build` / `tsc build` across all three workspaces.

## 3. Issues fixed

### CL-01 — Citekey path traversal through unvalidated downstream helpers

- **Severity:** Critical (path traversal / arbitrary file read-write)
- **File:** `server/src/services/library/paths.ts`
- **Symptom:** `recordPath`, `annotationsPath`, and `attachmentPath` all built their path by joining a caller-supplied `citekey` under `paperDir()`, but `paperDir()` itself did no validation. A citekey containing `../` (or, via an AI tool argument, an absolute-looking segment) could resolve outside `library/papers/`.
- **Fix:** added `assertSafeCitekey()` (length cap, character allowlist, explicit rejection of `/`, `\`, `..`) and call it once, inside `paperDir()`, so every downstream helper inherits the guard from a single choke point instead of needing its own copy.
- **Verification:** existing citekey-generation tests still pass; `npm run typecheck` + `npm test`.

### CL-02 — Claim-support cache key mismatch produces stale "supported" verdicts

- **Severity:** Critical (correctness of a truth-checking feature)
- **File:** `server/src/services/library/citations.ts`
- **Symptom:** `scanProjectCitations` (the write path, run on save/scan) and `verifyClaimInstance` (the read path, run by `library_verify` and the UI's re-check button) computed `claimHash` differently. A citing sentence could change at the same `file:line:citekey`, and `verifyClaimInstance` would still report the old, cached verdict for the old sentence — the exact failure mode this feature exists to prevent.
- **Fix:** unified the `claimHash` formula between both paths, and made `verifyClaimInstance` unconditionally rescan the file first rather than trusting a possibly-stale `claimText` passed in.
- **Tests:** new regression test in `citations.test.ts` ("re-checks when the citing sentence changes at the same file:line:citekey"). 3/3 tests pass.

### CL-03 — `verifyProposal`'s retraction check fabricated "clean" on network failure

- **Severity:** High (silent false-negative on a safety check)
- **File:** `server/src/services/library/verifyProposal.ts`
- **Symptom:** The pre-add gate's `checkRetraction` was a stub returning `"clean"` on every branch — hit, miss, *and* thrown network error — so a Crossref outage during an AI-proposed add looked identical to "checked, not retracted." The real check (`checkCrossrefRetraction`, already used post-add by `checkPaperIntegrity`) already existed and already fails closed (throws on non-404 HTTP errors) — the stub just never called it.
- **Fix:** `verifyProposal` now calls the real `checkCrossrefRetraction` (exported from `integrity.ts` for reuse) and lets a genuine failure propagate as a rejection instead of reporting a fabricated "clean". Threaded an optional `fetchImpl` through `verifyProposal` → `proposeVerifiedPaper` → `addVerifiedPaper` for testability, matching the existing test-injection pattern in `integrity.test.ts`.
- **Tests:** updated the existing DOI-only test to mock Crossref (it now genuinely reaches that code path), and added "rejects (fail-closed) when the retraction check itself fails, instead of fabricating 'clean'". 8/8 tests pass.
- **Note:** the *separate*, post-add fallback in `addVerifiedPaper` (which catches an integrity-check failure and keeps the paper anyway, relying on the periodic re-check to catch up later) was left unchanged — that's a defensible secondary safety net once the primary pre-add check is real, not a bug in its own right.

### CL-04 — Bearer-token AI `/lookup` and `/verify` missing the search-permission gate

- **Severity:** High (authorization)
- **Files:** `server/src/routes/libraryAi.ts`, `server/src/services/libraryAiMcp.ts`
- **Symptom:** `assertLibraryAiSearch(session)` already gated `/search`, `/recent`, and `/papers/:citekey` (REST) and the equivalent MCP tools, so a library-AI link minted with `allowSearch: false` couldn't originate a new outbound lookup — except through `/lookup` and `/verify`, which skipped the check on both the REST route and the MCP tool.
- **Fix:** added the same `assertLibraryAiSearch` call to both handlers, in both places.
- **Tests:** new file `libraryAiMcp.test.ts` (no prior coverage existed for this MCP surface at all) — confirms both tools reject with `allowSearch: false` (no network call attempted, since the assertion throws first) and that `library_search` still works with `allowSearch: true`. 3/3 pass.
- **Scope note:** the separate host-local MCP (`library/libraryMcp.ts`) does *not* need this fix — it's explicitly documented as inheriting OpenLeaf's local-trust-no-auth model, distinct from the Bearer-token surface.

### CL-05 — Bearer tokens logged in full via minted invite URLs

- **Severity:** High (credential exposure via logs)
- **Files:** `server/src/services/libraryAiShare.ts`, `server/src/services/libraryShare.ts`
- **Symptom:** minting a library-AI link or a library-share link logged the full invite URL, which embeds the session's bearer token / share token, to the console — `[library-ai] minted <id> → <url-with-token>`.
- **Fix:** log only the session id, matching `aiShare.ts`'s existing practice of never logging its own AI-link tokens.

### CL-06 — `citations.json` missing from the guest-forbidden-write list

- **Severity:** High (authorization)
- **File:** `server/src/services/projectFs.ts`
- **Symptom:** `isGuestForbiddenWritePath` blocked `comments.json` from guest file/fs writes but not the new `citations.json` (claim-support instances, git-tracked per project, same trust tier as comments) — a read-write guest could overwrite it directly through the generic file API.
- **Fix:** added `citations.json` to the same check.
- **Tests:** two new regression tests in `shareAuth.test.ts` mirroring the existing `comments.json` coverage. 14/14 tests pass.

### CL-07 — Unbounded PDF download (no size cap, no timeout)

- **Severity:** High (resource exhaustion / hang)
- **File:** `server/src/services/library/pdfFetch.ts`
- **Symptom:** `fetchAndAttachPdf` (used for both arXiv direct-PDF and Unpaywall OA-PDF fetches) buffered the entire response body with no cap and no fetch timeout — a very large PDF or a slow/stalled remote could exhaust memory or hang the request indefinitely.
- **Fix:** added a 100MB cap and a 45s timeout (`AbortSignal.timeout()`, the established pattern from `hostGateway.ts`). A `Content-Length` over the cap is rejected before any body read; a streaming body that exceeds the cap mid-transfer is aborted early rather than fully buffered first.
- **Tests:** new file `pdfFetch.test.ts` (no prior coverage existed) — simulates both the streaming-exceeds-cap case and the declared-Content-Length-exceeds-cap case using `node:stream/web`'s `ReadableStream`. 2/2 pass.

### CL-08 — BibTeX output didn't escape all LaTeX-active characters; citekey unescaped in a RegExp

- **Severity:** High/Medium (broken compile) + Low (ReDoS-adjacent correctness)
- **File:** `server/src/services/library/cite.ts`
- **Symptom:** `escapeBibtex` only escaped `{`, `}`, `\` — a real paper with `&`, `%`, `$`, `#`, `_`, `~`, or `^` in its title or author list (all common in real bibliographic data) produced a `.bib` entry that breaks `bibtex`/`pdflatex` compilation for the citing project. Separately, `syncCitekeyToBib` interpolated a citekey directly into `new RegExp(...)` with no escaping, so a citekey containing regex metacharacters could build an unintended pattern.
- **Fix:** extended `escapeBibtex` to cover all of the above (backslash-prefix for `&%$#_`; `\textasciitilde{}` / `\textasciicircum{}` for `~^`), and added `escapeRegExp()` to sanitize the citekey before use.
- **Tests:** new regression test in `cite.test.ts` covering all 7 characters. 3/3 pass.

### CL-09 — Share/AI-link/AI-review dialogs render inline, not as overlays, and behind the Library panel

- **Severity:** Critical (feature-breaking UX — the button that opens these does effectively nothing visible)
- **Files:** `client/src/components/LibrarySharePanel.tsx`, `LibraryAiLinkPanel.tsx`, `LibraryAiReviewPanel.tsx`, `client/src/styles.css`, `client/src/components/LibraryPanel.tsx`
- **Symptom:** the established pattern in this codebase is that `.history-drawer` supplies `position: fixed` + base z-index, and a component-specific class (`.library-share-drawer`, etc.) only adds deltas. All three of these new components used `.share-drawer library-share-drawer` on their outer `<div>` but never included `.history-drawer` — so they had no positioning at all and rendered as normal inline content inside the Library panel's layout instead of as an overlay. Even after adding positioning, `.library-share-drawer`'s `z-index: 40` sat *below* `.library-drawer`'s `z-index: 42` — since these components render as DOM children of the Library panel (which establishes its own stacking context via `position: fixed` + `z-index`), they'd still paint behind other Library panel content, not on top of it.
- **Fix:**
  1. Added `.history-drawer` and `aria-modal="true"` to all three components' outer `<div>`.
  2. Bumped `.library-share-drawer`'s `z-index` from 40 to 44 (above the Library panel's 42) in `styles.css`.
  3. In `LibraryPanel.tsx`: added a `useEffect` that resets all four sub-panel open flags (`importOpen`, `shareOpen`, `aiLinkOpen`, `aiReviewOpen`) to `false` when the Library panel itself closes, so reopening it doesn't resurrect a stale sub-dialog; and reordered the `onKeyDown` handler so Escape closes just the open sub-dialog first, before falling through to the panel's own Escape logic (previously Escape on a sub-dialog fell straight through to closing the whole Library panel).
- **Verification:** `npm run typecheck` + `npm run build` (client). No automated coverage for CSS positioning/stacking — this class of bug needs a rendered-DOM or visual check, which this pass didn't have Chromium available for; worth a manual click-through before shipping to test users.

### CL-10 — Stale draft text bleeds into a new annotation

- **Severity:** Medium (silent data-entry bug)
- **File:** `client/src/components/LibraryPdfNotes.tsx`
- **Symptom:** the tool-switch handler and the "start a new mark" handlers (`onAreaSelect`, `onPinAt`) cleared `pending`/`editingId` but not `draft`/`quote`. If a user began editing an existing annotation's note, then switched tools (or drew a new highlight/pin) instead of clicking Cancel, the new annotation's composer opened pre-filled with the *previous* annotation's text — and saving it would silently attach someone else's note to the new mark.
- **Fix:** clear `draft`/`quote` alongside `pending`/`editingId` in all three places.

### CL-11 — Annotation list can be clobbered by a stale in-flight refresh

- **Severity:** Medium (race condition)
- **File:** `client/src/components/LibraryPdfNotes.tsx`
- **Symptom:** `refresh()` had no guard against a paper switch happening mid-request — if a `listLibraryAnnotations` call for paper A was still in flight when the user switched to paper B, A's (stale) response could land after B's effect already ran, overwriting B's annotation list with A's.
- **Fix:** added a `citekeyRef` guard (mirrors the existing pattern in `LibraryPanel.tsx`'s `pdfHint` effect) — a resolved/rejected `refresh()` call now checks whether the paper it was requested for is still the current one before applying its result.

### CL-12 — `latexdiff`-missing check ran before commit-hash validation

- **Severity:** Medium (misdiagnosis)
- **File:** `server/src/services/trackChanges.ts`
- **Symptom:** discovered as a pre-existing baseline test failure while establishing this pass's starting point (not part of the citation-library feature itself, but touched by this branch and in scope for the "fix what's reasonably fixable" mandate). `generateTrackChangesUnlocked` checked `hasLatexdiff()` before validating the requested commit hashes, so on a machine without `latexdiff` installed, a request with an invalid/unknown commit hash returned 501 "latexdiff not installed" instead of the correct 404/400 — masking real client errors behind an environment-availability error.
- **Fix:** reordered validation to resolve and check commit hashes (including same-commit) before checking for `latexdiff`.

### CL-13 — Icon-only buttons missing accessible names

- **Severity:** Low (accessibility)
- **Files:** `client/src/components/LibraryPanel.tsx`, `LibraryPdfNotes.tsx`
- **Symptom:** several icon-only or glyph-only buttons (density toggle, Import `+`, Close `✕`, star toggle ×2, remove-topic, delete-annotation `×`) had a `title` but no `aria-label`, so their accessible name came from `title` alone (inconsistent screen-reader support) or from a unicode glyph whose spoken name isn't meaningful.
- **Fix:** added matching `aria-label`s (the remove-topic and star buttons get context-specific labels, e.g. `Remove topic ${tag}` rather than a generic label).

### CL-14 — Support-report path redaction missed several mount points and forward-slash Windows paths

- **Severity:** Low (privacy of the CLI's "paste into an AI assistant" support report)
- **File:** `cli/src/sanitize.ts`
- **Symptom:** `redactText`'s path-redaction rule covered `/home`, `/Users`, `/tmp`, `/var`, `/opt`, `/usr`, and backslash-style Windows paths only. `/mnt`, `/media`, `/srv`, macOS's `/Volumes`, and any Windows path written with forward slashes (e.g. normalized by another tool before being logged) passed through untouched — potentially leaking a username or project path into a report the user is told is "sanitized."
- **Fix:** extended the Unix-mount-point allowlist and generalized the Windows-path rule to accept either separator.
- **Tests:** new file `sanitize.test.ts` (no prior coverage existed) covering both gaps plus the original allowlist. 2/2 pass; full CLI suite 21/21 pass.

### CL-15 — Lookup-cache filename collision

- **Severity:** Low (latent correctness bug, low practical likelihood)
- **File:** `server/src/services/library/sources/lookupCache.ts`
- **Symptom:** `sanitizeKey()` lowercases, collapses every non-`[a-z0-9._-]` character to `_`, and truncates to 180 chars before building the cache filename (`${kind}-${sanitizeKey(key)}.json`, no uniqueness suffix). Two distinct keys that normalize to the same sanitized string (e.g. two keys differing only in punctuation that collapses to the same `_`, or two long keys that agree on their first 180 sanitized characters) would silently share, and overwrite, one cache file.
- **Fix:** append a short SHA-1 prefix of the original (un-sanitized) key to the filename.
- **Tests:** new file `lookupCache.test.ts` (no prior coverage existed) — confirms two colliding-after-sanitization keys get distinct files and round-trip independently. 2/2 pass.

### CL-16 — Malformed `?limit=` silently returns zero results

- **Severity:** Low (confusing UX, no crash)
- **File:** `server/src/routes/library.ts`
- **Symptom:** `Number(req.query.limit)` on a non-numeric value (e.g. `?limit=abc`) produces `NaN`, which flows into `searchPapers`'s `Math.min(Math.max(opts.limit ?? 500, 1), 2000)` clamp — still `NaN` — and `Array.prototype.slice(0, NaN)` returns an *empty* array. A malformed `limit` param silently returned a 200 with zero papers instead of falling back to the default page size or a clear 400.
- **Fix:** treat a non-finite parsed limit as `undefined`, so it falls through to the existing `?? 500` default.

## 4. Issues found but not fixed (deferred)

| ID | Severity | Why deferred | Recommended next step |
|----|----------|--------------|------------------------|
| CL-D1 | Medium | Bulk BibTeX import has no cap on entry count, and duplicate-detection calls a full O(n) library scan per imported entry (`findLikelyDuplicate` → `listAllRecords()`), so a very large `.bib` file does O(entries × library size) work on one request with no limit — a real resource-exhaustion vector on a single-user server, but fixing it properly means both an entry cap *and* addressing the O(n²) dedupe pattern, not a one-line change. | Add a max-entry cap (e.g. reject or truncate imports over ~500 entries with a clear message) and consider indexing dedupe candidates instead of a linear scan per entry. |
| CL-D2 | Low | The title-prefix dedupe heuristic (`titlesSoftMatch` in `dedupe.ts`: exact match or 40-char prefix containment, plus first-author check) has inherent false-positive risk (survey/series titles, "Part I"/"Part II" by the same first author) and false-negative risk (retitled preprint vs. camera-ready). This is a heuristic trade-off, not a bug with a clear correct fix. | If false positives/negatives show up with real usage, move to a token-set similarity or edit-distance measure with a tunable threshold, and add a "these look similar, not auto-merged" UI path instead of a binary yes/no. |
| CL-D3 | Medium | No rate-limiting infrastructure exists anywhere in this codebase (`server/src`, `client/src`, `cli/src` — confirmed via a full-repo search). `library_verify`/`library_lookup` (both originate outbound network calls under a minted AI Bearer token) and `touchVisitor` have no limits, but building this out means new middleware and per-key/per-IP counters from scratch, not a local patch. | Add a small per-token-per-minute counter (in-memory is fine for a single-process local server) in front of the two AI endpoints that make outbound calls, before exposing library-AI links more broadly. |
| CL-D4 | Low | CLI's interactive menu (`main.ts`) dispatches a typed choice with `dispatch(choice.split(/\s+/), new Map())` — flags typed at the interactive prompt (e.g. `reset-password --generate`) land as positionals since an empty flag map is always passed, so `--generate` is silently ignored and the command falls back to its interactive path instead of honoring the flag. | Route the typed choice through the same `parseArgs` used for real CLI args instead of hardcoding an empty flag map. |
| CL-D5 | Low | CLI's `runNpmBuild()` (`setup.ts`) spawns `npm run build` in the foreground with no explicit SIGINT/SIGTERM handler (unlike `cmdLogs`, which registers one). In a normal interactive TTY this is fine — terminal signals hit the whole foreground process group — but a non-TTY/CI invocation or a SIGKILL to the parent can orphan the build child and its own subprocess tree (tsc/vite/esbuild). | Wire the same signal-forwarding pattern `cmdLogs` already uses onto the build child, or run it detached with explicit process-group cleanup. |

## 5. Test / typecheck / build results

| Command | Result |
|---|---|
| `npm test` (server) | **184 pass / 0 fail** (4 skipped — `latexdiff` not installed in this sandbox, pre-existing and unrelated) |
| `npm test` (cli) | **21 pass / 0 fail** |
| `npm run typecheck` (server, client, cli via `--workspaces`) | **exit 0**, all three |
| `npm run build` (server, client, cli via `--workspaces`) | **exit 0**, all three (client's pre-existing >500kB main-chunk warning is unchanged, not introduced by this pass) |

New/extended test files this pass: `citations.test.ts`, `cite.test.ts`, `verifyProposal.test.ts`, `shareAuth.test.ts` (extended); `libraryAiMcp.test.ts`, `pdfFetch.test.ts`, `sources/lookupCache.test.ts`, `cli/src/sanitize.test.ts` (new — no prior coverage existed for any of these four).

## 6. Delivery

This session's GitHub access is read-only for `neoyinzhanghan/openleaf` (`add_repo` with `access: "push"` was refused: "the GitHub App isn't installed for this org"). All fixes above are committed locally on `audit/citation-library-quality-pass` (commit `ed6ccf6`, on top of `feature/citation-library` @ `4d3ba93`), which still fast-forwards cleanly from `main`. To bring these into your own remote:

```bash
# from your existing clone, with the openleaf remote configured
git fetch <this-audit's-source>   # or apply the attached patch file
git checkout feature/citation-library
git cherry-pick ed6ccf6           # or: git merge audit/citation-library-quality-pass
```

A `git format-patch` of this commit is attached alongside this report so it can be applied without a remote.
