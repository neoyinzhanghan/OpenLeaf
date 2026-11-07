# OpenLeaf Knowledge — Product and Technical Spec

Status: approved direction, ready to build. Read `BRIEF.md` first for how to work; this file says **what** to build.
Visual reference: `mockups/` (four screens). Where this spec and a mockup disagree, this spec wins.

---

## 1. The idea in one paragraph

OpenLeaf already does what Overleaf does: projects are folders of LaTeX that compile to PDF. Knowledge adds a research
"slip box" on top. **Facts** are raw pieces of information pulled from sources (papers, web pages); a person verifies each
one against the highlighted passage it came from. **Knowledge items** are short LaTeX write-ups that build on facts and on
other knowledge items, through explicit calculations, assumptions and judgment calls, each of which a person reviews.
**Projects** (papers, grants, decks) draw on both. AI agents (Cursor, Claude Code, MCP clients) do most of the gathering,
extracting and drafting. A person does all of the verifying. When anything a piece of work depends on is rejected or
changes, everything downstream is flagged for re-checking.

## 2. Non-negotiable principles

1. **Only a human can verify.** Confirming or rejecting a fact, and marking a step as reviewed, happens only through the
   host UI. No MCP tool, agent endpoint, or file edit can set a verified state. Any change made by anyone to something
   already verified returns it to "needs review".
2. **Trust flows downstream.** Status is computed from the dependency graph, never stored as a free-standing flag that
   could go stale.
3. **Everything is files.** Knowledge items are ordinary OpenLeaf projects (folders of LaTeX). Facts and sources live in
   the library folder as JSON next to the paper records they belong to. An agent with filesystem access can read
   everything; the server derives all state from those files.
4. **Compilation is just OpenLeaf.** Knowledge items compile with the existing compile pipeline. The only addition is a
   small LaTeX package plus a generated values file put on the TeX search path.
5. **Never invent numbers.** Demo or seed data must be visibly labelled as demo data in its title. No real-looking
   statistics without a real source.
6. **Additive, safe migrations.** Existing projects, papers, facts and their files keep working unchanged. New fields are
   optional with defaults. Before the first rewrite of any existing user file, write a one-time `.bak` copy.

## 3. Vocabulary

| Term | Meaning | Lives in |
|---|---|---|
| Source | Something facts are extracted from. A library paper (PDF) or, new, a saved web page. | `library/papers/<citekey>/` |
| Fact | One piece of raw information from one source, with the exact passage(s) it came from. | `library/papers/<citekey>/facts.json` |
| Knowledge item | A project whose `openleaf.json` has `"kind": "knowledge"`. A short LaTeX write-up built from facts and other knowledge. | `projects/<folder>/` |
| Project | Any other OpenLeaf project (a paper, grant, deck). May reference facts and knowledge. | `projects/<folder>/` |
| Step | One `calculation`, `assumption` or `judgment` environment inside a knowledge item, or its `\conclusion`. | inside `.tex` |
| Review | A person's verdict on a step, recorded with a hash of the step's text and a snapshot of its inputs. | `projects/<folder>/review.json` |
| Collection | A named group. Reuses library collections (`library/collections.json`) for papers, facts, knowledge and projects alike. | — |

## 4. Data model changes

### 4.1 Facts (extend `server/src/services/library/facts.ts`)

Add optional fields to `PaperFactSchema`, all with defaults so existing `facts.json` files parse unchanged:

- `key: string` — stable, human-readable, unique across the whole library. Pattern `^[a-z][a-z0-9-]{1,63}$`. Generated
  from `input` on creation (slugified, de-duplicated with `-2`, `-3`…). Existing facts without a key get one lazily on
  first read and it is persisted. Referenced from LaTeX as `\fact{key}`.
- `value: number | null` — the numeric value used in calculations. Parsed from `answer` for `value` facts (first number;
  strip thousands separators; `x%` → `x/100` with `unit: "%"`; `0.880 ± 0.057` → `0.88`). The user can override it in the
  UI. `null` when not numeric.
- `unit: string` — free text, default `""`.
- `createdBy: { kind: "human" | "agent", name: string }` — default `{ kind: "human", name: "" }`. Set to agent for anything
  created through MCP or the AI endpoints.
- `sourceKind: "pdf" | "web"` — default `"pdf"`.

Rules:

- Changing `answer`, `value`, `unit` or `highlights` on a `confirmed` fact sets it back to `unreviewed` unless the change
  comes from the host UI's own Confirm action with the new content.
- Rejecting a fact never deletes it. Rejected facts stay in the graph (shown red) so their downstream flags make sense.
- Fact keys can be renamed in the UI. Renaming offers to rewrite `\fact{old}` → `\fact{new}` across all projects
  (show the list of files and line counts first; apply only on confirm).
- A library-wide key index (in memory, rebuilt from files, cached by file mtimes) resolves `key → (citekey, factId)`.

### 4.2 Web sources (new)

Extend `PaperSourceSchema` with `"web"`. A web source is a library record like a paper, with:

- `url` (required), `title` (from the page `<title>` or user), `addedAt`.
- Files in `library/papers/<citekey>/`: `snapshot.txt` (readable text extracted from the page), `snapshot.json`
  (`{ url, fetchedAt, sha256, title, bytes }`). Optionally `snapshot.html` stored for provenance but **never served as
  HTML to the browser** (XSS risk); the UI only ever renders `snapshot.txt` as text.
- Fetch on the server, reusing the capped-body reader and timeout pattern in `pdfFetch.ts`; cap size at 5 MB. Unlike
  the PDF fetcher, the web fetcher must also: refuse non-http(s) URLs; refuse private, loopback and link-local addresses
  (resolve the hostname first; 127/8, 10/8, 172.16/12, 192.168/16, 169.254/16, ::1, fc00::/7, fe80::/10); follow
  redirects manually (at most 5) and re-check every hop. Tests need a local HTTP server, so allow private addresses only
  when `OPENLEAF_ALLOW_PRIVATE_FETCH=1` is set (tests set it; never default on).
- Facts on web sources use highlights with `page: 1` and character offsets into `snapshot.txt`.
- Introduce a small "source text" abstraction (`getSourceText(citekey)` → pages of text) so fact retrieval
  (`factRetrieve.ts`), quote location (`locateQuoteInPages`) and highlight display work for both PDFs and web text.
  Do not fork the fact logic per source kind.
- Readable-text extraction: prefer zero new dependencies (strip scripts/styles/nav, collapse whitespace). If quality is
  clearly insufficient, you may add a small, well-maintained extractor; record the choice in `DECISIONS.md`.

### 4.3 Knowledge items

A knowledge item is an OpenLeaf project. In its `openleaf.json`:

```json
{
  "kind": "knowledge",
  "knowledgeId": "us-market-size",
  "title": "US market size for DeepHeme",
  "collection": "deepheme-market",
  "mainFile": "main.tex",
  "engine": "pdflatex"
}
```

- `kind` defaults to `"paper"` when absent. Only `"paper"` and `"knowledge"` exist.
- `knowledgeId` is the stable id used by `\kn{…}` (same pattern as fact keys, unique across knowledge items). It is not the
  folder name, so renaming the project does not break references.
- `collection` (optional) is a library collection id. Regular projects may also set it.
- Everything projects already have (editor, history, timeline, comments, collab, share links, AI links) works unchanged
  for knowledge items.

New-item template (`main.tex`):

```latex
\documentclass{article}
\usepackage{openleaf-knowledge}
\begin{document}
\begin{knowledge}{Title of this knowledge item}

\conclusion{One or two sentences stating what this item concludes.}

\end{knowledge}
\end{document}
```

### 4.4 Review records (`projects/<folder>/review.json`, git-tracked like `comments.json`)

```json
{
  "version": 1,
  "steps": {
    "calculation:total": {
      "hash": "sha256 of the normalized step body",
      "verdict": "reviewed",
      "by": "Neo",
      "at": "2026-11-06T18:00:00Z",
      "inputs": {
        "fact:fee-per-read": { "value": 412.5, "status": "confirmed", "updatedAt": "…" },
        "kn:us-aspirates-per-year": { "result": 123456, "hash": "…" }
      }
    }
  }
}
```

- Step ids: `calculation:<name>` for named calculations; `assumption:<n>`, `judgment:<n>` (1-based order within the
  item) unless the environment has an optional `[id]`; `conclusion`.
- Normalization for the hash: strip comments, collapse whitespace.
- `verdict` is `reviewed` or `rejected` (a person can reject a step; the item then shows as needing work).
- Only the host UI writes this file (through a service function). If someone edits it by hand, the server still
  recomputes everything from the `.tex` and the hashes, so a hand edit cannot make changed text look reviewed.

## 5. The LaTeX side

### 5.1 Package `openleaf-knowledge.sty` (ships with the server, e.g. `server/tex/openleaf-knowledge.sty`)

Usable in any project, knowledge or paper.

| Command | In text | Inside a `calculation` |
|---|---|---|
| `\fact{key}` | The fact's display value (its `answer`, or formatted `value`+`unit`), styled, with a small superscript marker. Unknown key → bold red `??key` and a LaTeX warning. | The fact's numeric `value`. |
| `\kn{id}` | The item's primary result, formatted. | The item's primary result. |
| `\kn[name]{id}` | A named output of another item. | That output. |
| `\knref{id}` | The item's title. | (not allowed) |
| `\out{name}` | A result computed in this item. | That result. |
| `\conclusion{…}` | A shaded "Conclusion." block. | — |

Environments:

- `\begin{knowledge}[result=<name>]{Title}` … `\end{knowledge}` — title block; `result` names the primary output
  (default: the last calculation).
- `\begin{calculation}[unit=USD, digits=3]{name}` *expression* `\end{calculation}` — typesets
  "**n · Calculation.** name = *expression as written* = **value**".
- `\begin{assumption}[id]` … `\end{assumption}` and `\begin{judgment}[id]` … `\end{judgment}` — typeset as numbered steps
  ("Assumption.", "Judgment call."). Inside either, `\set{name}{number}` defines a named value usable via `\out{name}`.
- Steps are numbered in order across all three kinds.

Styling: quiet and print-friendly (the mockup's PDF panel is the reference): small-caps step labels, a light shaded box
for the conclusion, fact/knowledge values in a single accent colour, a "Built on" list at the end generated from the
references used (fact statement + source title + page/URL + saved date).

### 5.2 How values reach LaTeX

Before each compile of a project that uses the package:

1. The server parses the project's `.tex` (main file plus files reached by `\input`/`\include` inside the project) with the
   parser in 5.3, resolves every reference, evaluates calculations (5.4) and writes `openleaf-values.tex` defining one
   macro per value (`\olv@fact@<key>`, `\olv@kn@<id>@<name>`, `\olv@out@<name>`, plus display strings and status).
2. Both `openleaf-knowledge.sty` and `openleaf-values.tex` must be findable by TeX **without** weakening paranoid mode
   (`openin_any=p`, see `compiler.ts`). Paranoid mode refuses names with a leading dot component, so do **not** put them
   under `.openleaf/`. Put the package directory and a per-project generated directory (outside the project tree, under
   the server's own state dir) on `TEXINPUTS` for that compile only (`TEXINPUTS=<pkgdir>:<gendir>:` — note the trailing
   separator keeps the system tree). Verify with a real compile test that paranoid mode still blocks `\input{../x}`.
3. Errors (unknown key, cycle, bad expression) are reported in the compile log in the same style as LaTeX errors, with
   file and line, and as Monaco diagnostics (5.6). A compile with knowledge errors still produces a PDF (unknown values
   render as `??`).

### 5.3 Parser (`server/src/services/knowledge/parse.ts`, pure, heavily unit-tested)

Input: file map. Output: `{ title, resultName, steps: [{ id, kind, name?, line, endLine, body, refs[], sets[] }],
conclusion?, refs[], errors[] }`. Must handle: comments (`%` not preceded by `\`), nested braces, optional arguments,
multiple files, CRLF, environments split across lines. It is a tokenizer for this small command set, not a general LaTeX
parser; anything unrecognized is plain text.

### 5.4 Expression evaluator (`server/src/services/knowledge/evaluate.ts`, pure)

Grammar for `calculation` bodies: numbers (`1200`, `1.2e3`, `{,}` thousands separators allowed), `+ - * /`, `\times`,
`\cdot`, `\div`, `^`, unary minus, parentheses and `\left( … \right)`, braces as grouping, `\frac{a}{b}`, and references
`\fact{}`, `\kn{}`, `\kn[]{}`, `\out{}`. No other commands. Never use `eval`. Errors carry line numbers.

Evaluation across items: build a dependency graph over all knowledge items, evaluate in topological order, detect
cycles (every item in a cycle gets a "circular reference" error naming the cycle). A reference to a fact whose `value` is
`null` is an error ("fact has no numeric value"). A reference to a rejected fact still evaluates (so the old number is
shown) but marks the step flagged.

Number formatting for display: `digits` significant figures (default 3) with thousands separators; `unit=USD` → `$`;
`unit=%` → multiply by 100 and append `%`.

### 5.5 Status rules (`server/src/services/knowledge/status.ts`, pure)

Per **step**:
- `needs-review` — no review record, or hash differs from the current text.
- `rejected` — record verdict is `rejected` and hash matches.
- `flagged` — reviewed and hash matches, but any input it references (directly, by `\fact`/`\kn`/`\out` within the
  item) is now rejected, now flagged, or its value/hash differs from the snapshot taken at review time.
- `reviewed` — otherwise.

Per **knowledge item**: `rejected` if any step rejected; else `flagged` if any step flagged; else `needs-review` if any
step needs review; else `reviewed`. Errors (parse/eval) show as `needs-review` plus an error badge.

Per **fact**: its stored status (`confirmed`, `unreviewed`, `rejected`, `not_found`).

Per **project (paper)**: `flagged` if it references any fact or knowledge item that is rejected or flagged; otherwise
`up-to-date`.

"Flagged" always carries **why**: the list of upstream nodes that caused it (used by the impact view and tooltips).

### 5.6 Editor support (client, `client/src/latex/`)

In any project using the package:
- Completions after `\fact{` (keys, with statement, value and status in the detail), `\kn{` / `\knref{` (ids with
  titles), `\out{` (names defined in this file).
- Hover on a reference: statement/title, value, status, source.
- Diagnostics (squiggles) for unknown keys, cycles, bad expressions — from the same parser output, returned by the
  compile or by a lightweight `POST /api/projects/:id/knowledge/check`.
- Inline status dot decoration at the start of each step line (reviewed / needs review / flagged / rejected).

## 6. Graph service

`server/src/services/knowledge/graph.ts` builds one library-wide graph:

- Nodes: sources (papers and web pages that have at least one fact), facts (with keys), knowledge items, projects that
  reference at least one fact or knowledge item. Each node: `{ id, kind, name, status, why[], collection, note,
  inputs[], outputs[], updatedAt }`. Ids are prefixed: `src:<citekey>`, `fact:<key>`, `kn:<knowledgeId>`,
  `proj:<folder>`.
- Edges `{ from, to, flagged }` meaning "`to` is built on `from`": source→fact, fact→knowledge, knowledge→knowledge,
  fact/knowledge→project.
- Collection of a node: its explicit collection if it has one (paper collections, `openleaf.json` `collection`);
  otherwise the most common collection among its direct neighbours; otherwise `"unsorted"`.
- Built from files, cached, invalidated by file mtimes (a cheap mtime scan of `openleaf.json`, `review.json`, `.tex`
  files and `facts.json`/`record.json`; the collab disk watcher only runs while a room is open, so do not rely on it).
  Target: full rebuild of 5,000 facts / 500 knowledge items / 200 projects in
  under 1 s; incremental updates far faster.

API (all host-only, mounted like `/api/library`):
- `GET /api/knowledge/graph` → `{ nodes, edges, collections, generatedAt }` (whole graph; the client does focusing).
- `GET /api/knowledge/items` → list for pickers. `POST /api/knowledge/items` → create a knowledge item project from the
  template (`{ title, collection? }`).
- `POST /api/projects/:id/knowledge/check` → parse/eval result for the editor.
- `POST /api/projects/:id/knowledge/review` → `{ stepId, verdict: "reviewed" | "rejected" | "clear" }`. Host UI only.
- `GET /api/knowledge/impact?node=<id>` → everything downstream of a node with reasons (for the impact view).
- `GET /api/knowledge/inbox` → unreviewed facts, steps needing review, flagged items, grouped (section 7.4).

## 7. Screens

Use the app's existing design language: theme CSS variables in `client/src/styles.css` (there are many themes —
everything must work in all of them, light and dark), the app font, existing toolbar and panel components. The mockups
use hard-coded colours and Inter only because they are mockups. Add these theme tokens to **every** theme block, tuned
per theme for contrast (text 4.5:1, large/graphic 3:1):

`--kind-fact` (teal family, can equal `--accent`), `--kind-knowledge` (violet), `--kind-project` (blue),
`--kind-source` (muted slate), `--status-flag` (amber), `--status-reject` (can equal `--danger`).

### 7.1 Knowledge item editor (mockup `Main.dc.html`)

The existing editor page (`EditorPage.tsx`) in "knowledge mode" when the project's `kind` is `knowledge`:
- Header: breadcrumb (Knowledge / collection / title), status summary chip ("2 of 4 steps need review"), "View in tree",
  Recompile. Keep all existing editor functions available.
- Left: source editor with the 5.6 support. Small legend under the editor for `\fact`, `\kn`, `\out`.
- Middle: the compiled PDF. Toggle "Show review status": steps needing review / flagged are highlighted over the PDF
  using the same SyncTeX box mapping the "Highlight additions" feature uses (`diffHighlights.ts`, `synctex.ts`
  `boxesForFileLines`). Clicking a highlighted step opens it in the inspector. The downloaded PDF stays clean.
- Right inspector (collapsible): context-sensitive.
  - Cursor on a `\fact{}`: statement, key, value, status, source title/page/URL and saved date, the highlighted passage
    rendered from the source (PDF crop as the Facts page already does, or snapshot text for web), Confirm / Reject,
    "Also used by".
  - Cursor in a step: step kind, its inputs with statuses, Review / Reject / Clear review, and — if flagged — exactly
    which input changed (old → new value).
- Inline step status dots in the editor gutter.

### 7.2 Knowledge tree (mockup `Tree.dc.html` — interactive; its JS is the behavioural reference)

Route `/knowledge`. Add "Knowledge" to the top nav next to Library and Facts.

Look:
- Free, organic force-directed layout. **No columns.** Each collection is a soft group with a faint dashed halo and a
  small uppercase label (click label → collapse).
- Kind is colour (`--kind-*`). Size: source smallest, fact small, knowledge grows with how many things use it, project
  largest.
- Status on top of colour: filled = checked; hollow = not checked yet; amber pulsing ring = flagged; red = rejected.
- Edges: subtle by default with a gradient toward the dependent node (direction cue); in a focused branch they light
  up; links along which a change is spreading are animated amber dashes.
- Soft glow on lit nodes; smooth camera transitions; layout eases in on load and settles after drags.

Navigation tools (all required):
- Zoom (wheel, buttons, %), pan (drag background), Fit all, Fit branch.
- Minimap with viewport rectangle; click to jump.
- Focus: click a node → it, everything it is built on, and everything that uses it light up; the rest fades.
  Depth control: 1 step / 2 steps / All.
- "How does it connect to…": pick a second node; show the shortest path (undirected) and list it in the panel.
- Find: search box with instant results across all node names, keys and notes; choosing one focuses and flies to it.
- Show filters: per kind toggles with counts; "Needs attention only" (unchecked, flagged, rejected); labels Auto / All /
  Off. Auto shows labels for the focused branch, projects, and more as you zoom in (level of detail).
- Collections list: zoom to a collection; collapse/expand it into a single bubble with a count (edges re-route to the
  bubble).
- Recently visited trail (last 8), clickable.
- Hover card: kind, collection, name, status (with why), source/note, built-on and used-by counts.
- Drag a node to move it; the layout settles around it. Positions persist (section 6 cache or
  `library/.cache/graph-layout.json`) so the map stays stable between visits; new nodes appear near their neighbours.
- Panel "Open" opens the item: knowledge → its editor; fact → Facts page focused on it; source → Library; project → editor.
- Keyboard: canvas focusable; arrow keys pan, `+`/`-` zoom, `Esc` clears focus/path, `Enter` opens the focused node.
  Search and panel controls are normal focusable controls. Provide an accessible text alternative (the panel lists the
  focused branch as a navigable list).

Scale and performance (must be measured, section 9):
- Rendering: HTML canvas (2D) for nodes and edges with devicePixelRatio scaling; HTML overlay only for the hover card and
  controls. Hit-testing with a quadtree.
- Simulation: `d3-force` (allowed new dependency, plus `d3-quadtree`), run in a Web Worker when there are more than 400
  nodes; main thread stays responsive.
- Budget: with a synthetic graph of 3,000 nodes / 6,000 edges, pan and zoom stay at ≥ 50 fps on a typical laptop, focus
  changes respond in < 100 ms, initial render < 1.5 s.

### 7.3 Impact view (mockup `Changed.dc.html`)

Shown after rejecting a fact or rejecting a step (as a panel/drawer on the page where it happened, also reachable from a
flagged node): "3 things built on it are now flagged" with the chain, each item's reason, and "Not affected" summary.
Each flagged knowledge item, when opened, shows a banner: what changed, which steps use it, "Re-check these steps", and
"Ask agent to find a new source" (copies a ready-to-paste instruction for an agent; no automatic agent call in v1).

### 7.4 Review inbox (mockup `Review.dc.html`)

Route `/review`, nav item "Review" with a count badge. Groups:
- By agent session when known (facts and sources created through MCP carry `createdBy`; group by `name` and 30-minute
  windows), else "Changed outside OpenLeaf" (steps whose hash changed since review), else "Flagged".
- Rows: new facts (value, statement, source, See passage, Confirm, Reject), new sources, new knowledge drafts (Open and
  review), edits to previously reviewed steps with a word diff of old vs new step text (keep the last reviewed text in the
  review record to show this diff), flagged items.
- Bulk actions are allowed only for facts and only after opening each passage at least once (prevents rubber-stamping);
  show a gentle note explaining why if the user tries.

## 8. Agent access (MCP)

Extend the existing host MCP (`server/src/services/library/libraryMcp.ts`, `POST /api/library/mcp`) with:

| Tool | What it does |
|---|---|
| `source_add_web` | Save a web page as a source (`url`, optional `title`, `collection`). Returns citekey. |
| `facts_search` | Search facts by text/key/source/collection/status. |
| `fact_get` | One fact with its passages and status. |
| `fact_propose` | Create a fact on a source: `citekey`, `type`, `input`, `answer`, `quotes[]` (exact text from the source), optional `key`, `value`, `unit`. The server must find every quote in the source text (`locateQuoteInPages`); if any quote is not found, reject the call with a clear error. Status is always `unreviewed`; `createdBy` is the MCP client. |
| `knowledge_list` / `knowledge_get` | Items with title, id, collection, status, steps, values, errors, and the `.tex` source. |
| `knowledge_create` | Create a knowledge item project from the template; returns folder and id. Agents then edit its files directly. |
| `knowledge_check` | Parse, evaluate and compile an item; return errors, values and statuses. |
| `graph_neighborhood` | Nodes and edges around a node up to depth N. |

There is deliberately **no** tool to confirm, reject or review anything. Add a test asserting the tool list contains no
verification capability, and that `fact_propose` cannot produce anything but `unreviewed`.

Also add `docs/knowledge/AUTHORING.md` (for agents): how to write a knowledge item, the macros, the step kinds, the rule
"every number in a calculation must come from `\fact`, `\kn`, `\out` or a `\set` inside an assumption/judgment", "never
type a number you did not get from a source", and how to propose facts with exact quotes. Link it from `AGENTS.md`.

## 9. Quality bar

- Pure logic (parser, evaluator, status, graph build, key generation, value parsing, text extraction, path finding,
  layout helpers) in plain TypeScript modules with thorough unit tests using the repo's existing test runner
  (`tsx --test`). Include edge cases: CRLF, comments, nested braces, unicode titles, empty items, duplicate names,
  cycles, very long chains, 10k-node synthetic graphs for graph build time.
- Playwright e2e specs (repo already uses Playwright in `e2e/`) for: creating a knowledge item and seeing values compile;
  confirming/rejecting a fact and seeing downstream flags in editor, tree and inbox; tree focus/search/path/collapse;
  web source capture with a local test HTTP server (no internet in tests).
- No new console errors or warnings on any new page. Typecheck clean. Existing test suites stay green.
- Security: all new endpoints host-only; guest share links to a knowledge item behave exactly like any project (read-only
  guests cannot review); web snapshot never rendered as HTML; path safety through existing helpers; fetch limits as
  existing fetchers.
- Performance budgets in 6 and 7.2 measured by a script (`scripts/bench-knowledge-graph.ts`) and recorded in
  `PROGRESS.md`.

## 10. Demo data

`npm run seed:knowledge-demo` creates a self-contained demo in a separate `projects/demo-*` and library collection named
"DEMO — not real data": a few demo web sources served from local text, demo facts with obviously round numbers, the
"US market size (DEMO)" knowledge item with all three step kinds, a second knowledge item it builds on, one demo project
that cites it, and one rejected fact so flags are visible. It must be removable with
`npm run seed:knowledge-demo -- --remove`. Every demo title contains "DEMO".
