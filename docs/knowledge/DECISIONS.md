# Knowledge — decision log

One line per decision: **question** — choice — why. Newest at the bottom.

## Decided by the owner before the build
- **Is a knowledge item a new file type or a project?** — An OpenLeaf project with `"kind": "knowledge"`. — Reuses the editor, compile, history, comments and sharing; "the backend is fundamentally just OpenLeaf".
- **Knowledge format** — LaTeX, compiled by OpenLeaf. — Same tools as papers; agents already edit LaTeX well.
- **Do numbers recompute when a fact changes?** — Yes, calculations are live expressions over references. — Makes quick changes real.
- **Shared across projects or per project?** — Shared library-wide. — Knowledge is reused across papers, grants and decks.
- **Web pages as sources in v1?** — Yes. — Market research and similar work depend on them.
- **Can papers use facts and knowledge?** — Yes, through the same LaTeX package. — Every number in a paper can trace back to a checked source.
- **Tree layout** — Free force-directed graph; kind shown by colour, not columns; full navigation tool suite. — Must scale and stay readable as the library grows.

## Decided during the build
- **Client test runner invocation** — `node --import tsx --test client/src/**/*.test.ts` — Passing a directory made Node resolve `index.ts`; glob matches the server pattern.
- **Fact key optional in Zod, required after migrate** — Keep `key` optional in the schema so old files parse; `readFile` lazily assigns and persists. — Additive migration without a hard cutover.
- **confirmWithContent flag** — Host Confirm that edits answer/value in the same request passes `confirmWithContent: true` so status stays confirmed. — Spec: only the host Confirm action may keep verified state through an edit.
- **Tree layout persistence** — Client `localStorage` key `openleaf.knowledge.layout` (id → x,y). — Spec allows section-6 cache or client storage; client-only avoids new server writes for v1 UI.
- **Force sim on main thread for now** — `d3-force` + `d3-quadtree` in the page; Web Worker deferred until graphs regularly exceed ~400 nodes. — Keeps the first client ship small; API surface unchanged.
- **Inbox fact confirm gate** — `sessionStorage` remembers which fact passages were opened (“See passage”) before Confirm is allowed. — Spec bulk-confirm rule applied to single confirm too, without a server round-trip.
- **Knowledge mode detection** — Editor reads `openleaf.json` via existing `readProjectFile` rather than extending `ProjectMeta`. — Avoids an API shape change; config is already protected for writes.
- **writeProjectConfig must round-trip kind/knowledgeId/collection** — Extended read/write; earlier versions silently dropped them so list/graph saw zero items. — Root cause of empty Knowledge list after create.
- **Graph cache key** — Project `openleaf.json` / `review.json` / `main.tex` mtimes only (removed 2s time bucket). — Avoids stale cache and flaky e2e without busy-wait.
- **MCP tool count assertion** — Compare to `libraryMcpToolNames().length` instead of hard-coded 8. — Knowledge tools expanded the list.
- **Step edit detection** — Comments alone do not invalidate review hashes (`normalizeStepText` strips `%`); tests change real expression text. — Matches authoring intent.
- **Seed script** — TypeScript via `tsx` (`scripts/seed-knowledge-demo.mts`) wrapped by `.mjs` npm script. — Reuses server services; DEMO titles everywhere.
- **PDF review overlay deferred** — Inspector + gutter + flagged banner ship first; SyncTeX overlay logged as blocker. — Highest-value review path without blocking handover.
- **Graph shows only knowledge-cited facts/sources** — Override SPEC §6 “all facts with keys”; a fact/source node appears only if a knowledge item `\fact{…}` cites it. — Keeps the tree usable; Facts page still lists the full library.
- **Graph/inbox skip PDF display rects** — `listAllFacts({ skipDisplay: true })` / `getFactsByKeys`. — `withDisplay` was loading every PDF text cache and dominated rebuild time.
- **Local Kùzu derived index** — `kuzu@0.11.3` under `library/.cache/knowledge.kuzu`; files remain source of truth; graph DB is a rebuildable cache (like FTS sqlite). — Fast neighborhood/search without abandoning local-first files.
- **Hybrid nodes** — Index stores topology + `pathRef` into library/projects files; opening knowledge still opens the project folder / PDF / snapshot. — Graph for retrieval; files for content.
- **Progressive disclosure** — Default canvas hides fact/source nodes; focus loads `/api/knowledge/neighborhood` (incl. sibling facts on touched sources) and reveals the lit branch. — Matches “hidden until you look”.
- **Tree vs index** — Default tree only `inTree` nodes (knowledge-cited facts/sources + kn/projects); full fact set is indexed for search/neighborhood. — Sparse UI, complete retrieval.
- **Authored papers vs knowledge** — Graph `project` nodes only for OpenLeaf projects with explicit `"kind": "paper"` (Inference Powered Prediction, WSIP Paper, Reframing AIT FAccT, Label-free correction for label shift, DeepHeme MSK NatMed). Other folders are knowledge or notes, not papers. Papers render as amber rounded squares; knowledge as violet ringed discs. — Owner taxonomy; keeps benches/talks out of the paper layer.
