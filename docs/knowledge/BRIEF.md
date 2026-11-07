# Build brief: OpenLeaf Knowledge (read this first)

You are building the Knowledge feature for OpenLeaf, end to end, **autonomously**. The owner is not watching. Do not stop
to ask questions, do not wait for approval between phases, and do not end your run early. Work until every phase below
meets its acceptance criteria, or until everything left is recorded as a blocker with evidence.

Files in this folder:
- `SPEC.md` — what to build (the source of truth).
- `mockups/` — four screen designs as `.dc.html` sources. They are design references, not runnable pages (they depend on
  a design-tool runtime). Read their markup for layout, spacing and colours, and read `mockups/Tree.dc.html`'s
  `<script>` for the intended tree behaviour (force layout, focus, path, filters, collapse, minimap, labels).
- `PROGRESS.md` — your running checklist. Keep it current; it is how the owner sees what happened.
- `DECISIONS.md` — your decision log. Every judgment call goes here.

---

## How to work

1. **Branch.** Work on a new branch `knowledge-v1` created from the current branch. Commit after every completed task
   with a clear message (`knowledge: <what>`). Push the branch if a remote is configured. Never force-push, never rewrite
   history, never touch `main`.
2. **Read before writing.** Before each phase, read the files that phase touches (paths are listed). Follow the existing
   conventions in `AGENTS.md`: routes thin, logic in services, typed client wrappers in `client/src/api/`, path safety
   through the existing helpers.
3. **Tests first for logic.** For every pure module, write the tests first, then the code. Server tests run with
   `npm test` (`tsx --test`). The client has pure-logic test files (e.g. `client/src/latex/libraryLink.test.ts`) that no
   script currently runs: add `client/src/**/*.test.ts` to `scripts/test-all.mjs` (via `tsx --test`) in Phase 0 so they
   run, and put new client logic tests there.
4. **The verification loop**, after every task, in this order, and fix until all pass:
   `npm run typecheck` → `npm test` → `npm run build` → the Playwright specs you added or touched (`npx playwright test
   e2e/<spec>`). At the end of each phase also run the **full** `npm run e2e`.
5. **Self-review before each commit.** Re-read your diff as a strict reviewer: security (host-only endpoints, path
   safety, no HTML injection), error handling (every async path has a user-visible error state), empty states, loading
   states, all themes, phone width, no stray console logs, no dead code, no TODOs left without a `PROGRESS.md` entry.
6. **When something is ambiguous**, pick the option most consistent with `SPEC.md` and the existing app, write it in
   `DECISIONS.md` (one line: the question, the choice, why), and continue. Do not block on it.
7. **When stuck**, try at least three genuinely different approaches. If still stuck, record it under "Blockers" in
   `PROGRESS.md` with the error output and what you tried, then move on to the next task that does not depend on it.
   Come back to blockers at the end.
8. **Never** weaken existing security (paranoid TeX mode, host-only routes, share/guest restrictions), delete user data,
   reformat unrelated files, or change behaviour of existing features beyond what the spec requires. Migrations are
   additive and lazy; write a one-time `.bak` before the first rewrite of any existing user file.
9. **Dependencies.** Allowed: `d3-force`, `d3-quadtree` (client). Anything else needs a clear reason in `DECISIONS.md`
   and must be small and well maintained.
10. **TeX in tests.** Some tests need a real `pdflatex`/`latexmk`. Follow the pattern existing compiler tests use. If TeX
    is missing in your environment, install TeX Live if you can; otherwise mark those tests skipped with a clear reason
    and note it in `PROGRESS.md`.

---

## Phases

Each phase lists what to read, what to build, and how you know it is done. Do them in order.

### Phase 0 — Baseline
Read: `AGENTS.md`, `README.md`, `SPEC.md`, `scripts/test-all.mjs`, `playwright.config.ts`, `e2e/instance.ts`.
Build: create the branch; run install, typecheck, tests, build, e2e and record the baseline (what passes, what fails
before you changed anything) in `PROGRESS.md`; wire client `*.test.ts` into `scripts/test-all.mjs`.
Done when: baseline recorded; any pre-existing failures listed as "pre-existing, not caused by this work".

### Phase 1 — Facts foundations (SPEC 4.1)
Read: `server/src/services/library/facts.ts`, `factRetrieve.ts`, `pdfText.ts`, `routes/library.ts`,
`client/src/components/LibraryFactsView.tsx`, `LibraryPaperFacts.tsx`, `client/src/api/*`.
Build: `key`, `value`, `unit`, `createdBy`, `sourceKind`; key generation and library-wide uniqueness; lazy migration;
value parsing; status reset on edits; key index; key rename with reference rewrite (preview then apply); show key/value
in the Facts UI with copy-`\fact{key}` button.
Done when: unit tests cover key generation, collisions, value parsing (percent, ±, separators, negatives, none),
migration of an old `facts.json`, status reset; the Facts page shows keys; all checks green.

### Phase 2 — Web sources (SPEC 4.2)
Read: `pdfFetch.ts`, `library/index.ts`, `library/types.ts`, `LibraryPanel.tsx`.
Build: safe fetcher; snapshot files; source-text abstraction shared by PDF and web; fact retrieval and quote location
on web text; Library "Add web page" action; Facts view shows the snapshot text with highlights.
Done when: tests cover private-address refusal, redirect re-check, size cap, text extraction, quote location on web
text; an e2e test adds a page from a local test server and creates/confirms a fact on it.

### Phase 3 — Knowledge items and compilation (SPEC 4.3, 5.1–5.4)
Read: `projectFs.ts`, `compiler.ts`, `routes/projects.ts`, `ProjectList.tsx`.
Build: `kind`/`knowledgeId`/`collection` in project config; template and `POST /api/knowledge/items`; the parser; the
evaluator; cross-item evaluation with cycle detection; `openleaf-knowledge.sty`; generated values file on `TEXINPUTS`
for the compile only; errors in the compile log; Project list: filter (All / Papers / Knowledge) and "New knowledge item".
Done when: parser and evaluator have exhaustive unit tests (SPEC 9); a real compile test produces a PDF with computed
values; a test proves paranoid mode still blocks `\input{../secret}`; an unknown key compiles with `??` and a reported
error; a two-item chain (`\kn`) evaluates; a cycle is reported on both items.

### Phase 4 — Review and status engine (SPEC 4.4, 5.5, 6)
Build: `review.json` service; step ids and hashing; review endpoint (host UI only); input snapshots; status computation
with reasons; graph build with caching; `impact` and `inbox` endpoints.
Done when: tests prove: editing a reviewed step returns it to needs-review; rejecting a fact flags every downstream step,
item and project transitively, with correct reasons; restoring the fact value clears the flag; a hand-edited
`review.json` cannot mark changed text as reviewed; graph build of a 10k-node synthetic library meets the SPEC target
(measure and record).

### Phase 5 — Knowledge item editor (SPEC 5.6, 7.1; mockup `Main.dc.html`)
Read: `EditorPage.tsx`, `PdfViewer.tsx`, `CodeEditor.tsx`, `client/src/latex/*`, `diffHighlights.ts`, `synctex.ts`.
Build: knowledge mode header; completions, hovers, diagnostics, gutter status dots; PDF review overlay via SyncTeX;
inspector for facts and steps with Confirm/Reject/Review; theme tokens added to every theme in `styles.css`.
Done when: e2e: create item → insert `\fact{}` via completion → compile shows value → review a step → edit it → it shows
needs-review again; looks right in at least four themes including one light theme (take Playwright screenshots into
`docs/knowledge/screenshots/` and compare against the mockup yourself).

### Phase 6 — Knowledge tree (SPEC 7.2; mockup `Tree.dc.html`)
Build: `/knowledge` route and nav item; canvas renderer; `d3-force` simulation (Web Worker above 400 nodes); every
navigation tool listed in SPEC 7.2; layout persistence; keyboard support; text alternative.
Done when: e2e covers focus, depth, search-and-fly, path finding, kind filters, needs-attention, collapse/expand,
minimap click, drag; `scripts/bench-knowledge-graph.ts` with 3,000 nodes / 6,000 edges meets the SPEC budget (record
numbers); screenshots in two themes saved and compared against the mockup.

### Phase 7 — Impact view and review inbox (SPEC 7.3, 7.4; mockups `Changed.dc.html`, `Review.dc.html`)
Done when: e2e: an agent-created fact (create it through the MCP tool) appears in the inbox under that agent's group;
rejecting it shows the impact view with the right chain; opening a flagged item shows the banner; an edited step shows
its word diff.

### Phase 8 — Agent tools (SPEC 8)
Read: `libraryMcp.ts` and its tests, `libraryAiMcp.ts`.
Build: the tools; `docs/knowledge/AUTHORING.md`; link it from `AGENTS.md`; update `AGENTS.md` layout table.
Done when: tests cover every tool, quote verification, the "no verification capability" assertion, and that agent-made
facts are always `unreviewed` with `createdBy.kind = "agent"`.

### Phase 9 — Projects use knowledge (SPEC 5.1, 5.5)
Build: `\fact`/`\kn` in ordinary paper projects; flagged-number banner in the paper editor; projects appear in the tree.
Done when: e2e: a paper citing `\kn{}` shows the value; rejecting an upstream fact flags the paper in editor, tree and
inbox.

### Phase 10 — Hardening and handover
Build: `npm run seed:knowledge-demo` (and `-- --remove`); README section "Knowledge"; final pass on loading/empty/error
states, phone width, keyboard access, contrast in all themes; remove dead code.
Bug bash: run the full suite three times in a row (flaky tests must be fixed, not retried); open every new screen with
the demo seed and with an empty library; check the browser console is clean on every new page; try malformed LaTeX,
huge expressions, deleted sources, renamed projects, renamed fact keys, a library with no facts.
Done when: every box in `PROGRESS.md` is checked or has a blocker entry with evidence; final summary written at the top
of `PROGRESS.md` (what was built, how to try it in five steps, known limitations, numbers from the benchmarks).

---

## Definition of done (whole project)

- Every acceptance criterion above met, all suites green three runs in a row, typecheck and build clean.
- No regressions in existing features (existing e2e and unit tests unchanged and passing).
- Performance budgets met and recorded.
- Docs updated: `README.md`, `AGENTS.md`, `docs/knowledge/AUTHORING.md`, `PROGRESS.md`, `DECISIONS.md`.
- The demo seed shows every screen working with no manual setup.
