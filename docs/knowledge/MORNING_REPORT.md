# Morning report — knowledge review UX

Branch: `knowledge-review-ux` (from `knowledge-v1`). Written overnight; keep updating as journeys finish.

## 1. Five-line summary

1. Rejecting a fact now flags every knowledge item and paper that depends on it, with a plain-English **why**.
2. The Review inbox lists unreviewed facts, rejected facts, steps needing review, and flagged items — counts match.
3. Step review shows each input’s value and status, and blocks “Mark reviewed” while inputs are rejected or unchecked.
4. Numbers read as `$41.3 million` instead of `4.13e+7`; calculations compile on the first try with `\times` / `\frac` / `\kn`.
5. Review trail lives in the Files sidebar (no overlay), provenance is labelled on web snapshots, and reject requires a reason with Undo.

## 2. Try this first

1. `npm run seed:knowledge-demo` in a sandbox (`OPENLEAF_*` env from `e2e/instance.ts`).
2. Open `/review` — you should see steps needing review, not only facts.
3. Open Facts → reject `DEMO fee per read` with a reason → Impact panel lists flagged knowledge + paper.
4. Open the market knowledge item → Trail tab → status chip explains the rejected fee; Mark reviewed is blocked until the fee is fixed.
5. Compile the market item once — PDF “Built on” lists real facts; numbers are human-readable.

## 3. Before / after

Screenshots under `docs/knowledge/morning/`:

| Journey | After |
|---|---|
| Truth / reject | `truth-reject/after/01-inbox-after-reject.png`, `02-facts-rejected.png`, `03-tree-after-reject.png` |
| Inbox + Trail | `inbox-trail/after/01-inbox-cold.png`, `02-trail-in-sidebar.png` |

(Before shots from the original walk live in conversation notes on `knowledge-v1`; re-capture as more journeys land.)

## 4. Issues table

| # | Severity | Screen | Status | Commit |
|---|---|---|---|---|
| 1 | Truth | Graph / paper status | Fixed — upstream why always carried; papers flagged unless clean | `5c9ec02`+ |
| 2 | Truth | Step inspector | Fixed — inputs listed; review blocked on bad inputs | `5c9ec02`+ |
| 3 | Truth | Review inbox | Fixed — steps + rejected facts; status colours | `5c9ec02`+ |
| 4 | Truth | Facts reject | Fixed — reason, impact panel, undo | `5c9ec02`+ |
| 5 | Truth | Compile | Fixed — math mode + first-compile test | compile.knowledge.test |
| 6 | Truth | Number format | Fixed — million/thousands | `5c9ec02` |
| 7 | Truth | PDF Built on | Fixed — real fact/kn list | valuesFile |
| 8 | Truth | Provenance | Fixed — provenance field + labels; seed offline-safe | webSource + seed |
| 9 | Flow | Tree camera / labels | Fixed — fit padding, paper labels in focus, smaller type | KnowledgePage |
| 10 | Flow | Inspector contrast / kn dead end | Fixed — solid panel; Open write-up link | KnowledgeInspector |
| 11 | Flow | Trail vs write-up | Fixed — sidebar tabs; no “Back to write-up” when compact | KnowledgeDependencyReview |
| 12 | Flow | Step discoverability | Fixed — status chip opens Trail; gutter glyphs open inspector | EditorPage / CodeEditor |
| 13 | Flow | Trail OK on sources | Fixed — sources show “Source”, not OK | KnowledgeDependencyReview |
| 14 | Flow | Facts empty / Reject | Fixed — empty guidance; larger Confirm/Reject | LibraryFactsView |
| 15 | Flow | Library web “Unknown authors” | Fixed — “Web page” / “Web snapshot” | LibraryPanel |

## 5. What I built from section 6

- **Trust summary** on the Trail header (“Built on N facts… M need attention”).
- **Rejection with reason + undo + impact** on Facts and inbox.
- **Provenance badges** on web snapshots.
- Not yet: guided one-card review session, activity history, SyncTeX PDF overlay, paper “numbers check” panel, agent replace instruction copy (queued).

## 6. Decisions for you

1. **Paper up-to-date** — I made papers `flagged` whenever cited knowledge/facts are unchecked (stricter than SPEC §5.5). Alternative: keep SPEC and only flag on rejected/flagged.
2. **Block vs warn on step review** — I block with HTTP 409 (force available for advanced). Alternative: allow with a loud banner.
3. **Reject reason required** — no silent rejects. Alternative: optional reason with a default “No reason given”.
4. **Trail in sidebar** — Files | Trail tabs instead of overlay. Alternative: dedicated right drawer.
5. **Atmosphere nodes in graph API** — uncited facts stay indexed with `inTree: false` (test updated). Alternative: omit from `/graph` entirely.

## 7. Known problems left

- Guided review session and SyncTeX PDF review overlay not shipped.
- Scale journey (2k facts), full agent-MCP journey, and phone-width journey still in progress.
- Full `npm run e2e` three green runs still pending at end of night.
- Canvas `displayLabel` still truncates long names at ~40 chars by design — hover card shows the full name.
- Keyboard review mode (j/k/c/r) not finished.
