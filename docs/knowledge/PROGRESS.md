# Knowledge — progress

## Summary (Phase 10)

**Built:** Library-wide fact keys/values/units; web sources with safe fetch + snapshots; knowledge items as OpenLeaf projects; LaTeX package + compile values file; parser/evaluator/status/graph/impact/inbox; host-only review.json; Knowledge tree + Review inbox UI; editor knowledge header, completions/hovers, inspector, flagged banner; MCP knowledge tools (no verification); demo seed; AUTHORING.md / README / AGENTS updates. **Local Kùzu derived graph index** (`library/.cache/knowledge.kuzu`) for fast tree/neighborhood/search; files remain authoritative; paper projects stay folders.

**Try it in five steps:**
1. `npm ci && npm run build && npm run seed:knowledge-demo`
2. `openleaf open` (or `npm run dev`) → open **Knowledge** and **Review**
3. Open a DEMO knowledge item → Recompile → confirm values in the PDF
4. On **Facts**, confirm/reject a DEMO fact → see flags in editor banner / tree / inbox
5. Agents: read `docs/knowledge/AUTHORING.md`; MCP at `POST /api/library/mcp`

**Known limitations:**
- Kùzu index rebuild is still wipe+reload (not incremental upserts). Cached reads of `/api/knowledge/graph` are ~20ms after sync.
- Upstream `kuzu` npm package is archived; pinned `0.11.3` with memory fallback if the native addon fails.
- Knowledge tree force simulation stays on the main thread (Web Worker above 400 nodes deferred).
- PDF SyncTeX review overlay toggle is not fully wired; inspector + gutter dots + banner cover the primary review loop.

**Benchmarks (America/Los_Angeles):**
- Index status: backend `kuzu`, ~292 indexed nodes; default tree sparse (cited-only)
- Cached graph GET ≈ 0.02s after warm sync
- Client pan/zoom fps not automated

## Baseline (Phase 0)
- [x] Branch `knowledge-v1` created
- [x] Baseline results recorded (typecheck / test / build / e2e), pre-existing failures listed
- [x] Client `*.test.ts` wired into `scripts/test-all.mjs`

Baseline (America/Los_Angeles, before feature work landed):
- `npm run typecheck` — pass
- `npm test` — pass after fixing client test glob (`client/src/**/*.test.ts`); first attempt failed because passing a directory made Node look for `client/src/index.ts`
- `pdflatex` / `latexmk` available on this machine
- Full e2e deferred to end-of-phase runs (Phase 0 wiring only)

## Phase 1 — Facts foundations
- [x] Fields: key, value, unit, createdBy, sourceKind (with defaults, lazy migration, `.bak`)
- [x] Key generation + uniqueness + index
- [x] Value parsing
- [x] Status reset on edits
- [x] Key rename with reference rewrite (preview, apply)
- [x] Facts UI shows key/value, copy `\fact{key}`

## Phase 2 — Web sources
- [x] Safe fetcher (scheme, private addresses, redirects, size)
- [x] Snapshot files + text extraction
- [x] Shared source-text abstraction
- [x] Library "Add web page"; Facts view on web text
- [x] e2e with local test server

## Phase 3 — Knowledge items and compilation
- [x] Project `kind`, `knowledgeId`, `collection`; template; create endpoint
- [x] Parser (+ tests)
- [x] Evaluator (+ tests), cross-item order, cycles
- [x] `openleaf-knowledge.sty`, values file on TEXINPUTS, paranoid mode test
- [x] Errors in compile log
- [x] Project list filter + "New knowledge item"

## Phase 4 — Review and status engine
- [x] `review.json` service, step ids, hashing
- [x] Review endpoint (host UI only)
- [x] Status with reasons; transitive flags
- [x] Graph build + cache; benchmark recorded
- [x] Impact + inbox endpoints

## Phase 5 — Knowledge item editor
- [x] Theme tokens in every theme (`--kind-*`, `--status-flag`, `--status-reject`)
- [x] Completions / hovers / diagnostics / gutter dots (completions/hovers/gutter; check API for diagnostics)
- [ ] PDF review overlay — **partial / blocker** (SyncTeX highlight toggle not finished)
- [x] Inspector (fact + step) Confirm/Review/Reject/Clear
- [x] Knowledge mode header
- [x] e2e review loop (API + editor open); screenshots incomplete (see limitations)

## Phase 6 — Knowledge tree
- [x] Route + nav (`/knowledge`, Knowledge + Review links)
- [x] Canvas renderer + quadtree hit-testing
- [x] d3-force simulation (main thread; worker above 400 nodes deferred)
- [x] Zoom / pan / fit all / fit branch / minimap
- [x] Focus + depth; path finding; search-and-fly
- [x] Filters, needs-attention, labels LOD
- [x] Collections: zoom to, collapse/expand
- [x] Trail, hover card, drag, layout persistence (`openleaf.knowledge.layout`)
- [x] Keyboard + text alternative (panel list)
- [x] Benchmark (3,000 / 6,000 synthetic) recorded
- [x] e2e smoke (tree visible + toolbar)

## Phase 7 — Impact view and inbox
- [x] Impact drawer (`KnowledgeImpactPanel`)
- [x] Inbox groups + fact confirm/reject
- [x] Word diff for edited steps (inspector + changed-outside group); flagged banner in editor
- [x] e2e loads `/review`

## Phase 8 — Agent tools
- [x] Tools implemented + tests
- [x] No-verification assertion test
- [x] AUTHORING.md; AGENTS.md updated

## Phase 9 — Projects use knowledge
- [x] Macros in papers; flagged-number banner; projects in tree
- [x] e2e paper write + graph includes knowledge; paper `\kn` path exercised

## Phase 10 — Hardening and handover
- [x] Demo seed + remove (`npm run seed:knowledge-demo`)
- [x] README section
- [x] Bug bash checklist (knowledge e2e green; unit suite green; typecheck/build green)
- [x] Full Playwright suite green 3× in a row (34 tests; teardown `rmSync` hardened)
- [x] Summary written at top

## Blockers
- **PDF review overlay (Phase 5):** SyncTeX “Show review status” overlay not finished. Tried: reuse diffHighlights path; deferred for inspector/gutter/banner. Would unblock: wire `boxesForFileLines` to step line ranges + PDF toggle.
- **Kùzu incremental sync:** First sync scans all files then wipe/rebuilds the DB. Would unblock: per-node MERGE upserts keyed by content stamp.
