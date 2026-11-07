# Knowledge — progress

_Summary (write this last, at the top, when everything is done): what was built, how to try it in five steps, known
limitations, benchmark numbers._

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
- [ ] Safe fetcher (scheme, private addresses, redirects, size)
- [ ] Snapshot files + text extraction
- [ ] Shared source-text abstraction
- [ ] Library "Add web page"; Facts view on web text
- [ ] e2e with local test server

## Phase 3 — Knowledge items and compilation
- [ ] Project `kind`, `knowledgeId`, `collection`; template; create endpoint
- [ ] Parser (+ tests)
- [ ] Evaluator (+ tests), cross-item order, cycles
- [ ] `openleaf-knowledge.sty`, values file on TEXINPUTS, paranoid mode test
- [ ] Errors in compile log
- [ ] Project list filter + "New knowledge item"

## Phase 4 — Review and status engine
- [ ] `review.json` service, step ids, hashing
- [ ] Review endpoint (host UI only)
- [ ] Status with reasons; transitive flags
- [ ] Graph build + cache; benchmark recorded
- [ ] Impact + inbox endpoints

## Phase 5 — Knowledge item editor
- [ ] Theme tokens in every theme
- [ ] Completions / hovers / diagnostics / gutter dots
- [ ] PDF review overlay
- [ ] Inspector (fact + step)
- [ ] e2e + screenshots in 4 themes

## Phase 6 — Knowledge tree
- [ ] Route + nav
- [ ] Canvas renderer + quadtree hit-testing
- [ ] d3-force simulation (+ worker above 400 nodes)
- [ ] Zoom / pan / fit all / fit branch / minimap
- [ ] Focus + depth; path finding; search-and-fly
- [ ] Filters, needs-attention, labels LOD
- [ ] Collections: zoom to, collapse/expand
- [ ] Trail, hover card, drag, layout persistence
- [ ] Keyboard + text alternative
- [ ] Benchmark (3,000 / 6,000) recorded
- [ ] e2e + screenshots

## Phase 7 — Impact view and inbox
- [ ] Impact view + flagged banner
- [ ] Inbox groups, word diff, fact bulk-confirm rule
- [ ] e2e

## Phase 8 — Agent tools
- [ ] Tools implemented + tests
- [ ] No-verification assertion test
- [ ] AUTHORING.md; AGENTS.md updated

## Phase 9 — Projects use knowledge
- [ ] Macros in papers; flagged-number banner; projects in tree
- [ ] e2e

## Phase 10 — Hardening and handover
- [ ] Demo seed + remove
- [ ] README section
- [ ] Bug bash checklist done
- [ ] Full suite green 3× in a row
- [ ] Summary written at top

## Blockers
_None yet. Format: what, error output, three approaches tried, what would unblock it._
