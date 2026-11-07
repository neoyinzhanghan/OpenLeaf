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
