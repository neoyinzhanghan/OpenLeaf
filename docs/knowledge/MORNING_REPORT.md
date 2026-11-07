# Morning report — knowledge review UX

Branch: `knowledge-review-ux` (from `knowledge-v1`). Overnight work finished with all section-4 journeys green three times in a row.

## 1. Five-line summary

1. Rejecting a fact now flags every knowledge item and paper that depends on it, with a plain-English **why**.
2. The Review inbox lists unreviewed facts, rejected facts, steps needing review, and flagged items — counts match.
3. Step review shows each input’s value and status, and blocks “Mark reviewed” while inputs are rejected or unchecked.
4. Numbers read as `$41.3 million` instead of `4.13e+7`; calculations compile on the first try with `\times` / `\frac` / `\kn`.
5. Review trail lives in the Files sidebar; guided review + trust summary ship; provenance is labelled; Kùzu no longer segfaults the API under Review polling.

## 2. Try this first

1. `npm run seed:knowledge-demo` in a sandbox (`OPENLEAF_*` env from `e2e/instance.ts`).
2. Open `/review` — you should see steps needing review, not only facts.
3. Open Facts → reject `DEMO fee per read` with a reason → Impact panel lists flagged knowledge + paper.
4. Open the market knowledge item → Trail tab → Start guided review; status chip explains the rejected fee; Mark reviewed is blocked until the fee is fixed.
5. Compile the market item once — PDF “Built on” lists real facts; numbers are human-readable.

## 3. Before / after

Screenshots under `docs/knowledge/morning/`:

| Journey | After |
|---|---|
| Agent → trusted | `agent-to-trusted/after/01-inbox-from-agent.png`, `02-trusted-trail.png` |
| Wrong number | `wrong-number/after/01-reject-impact.png`, `02-clean-after-replace.png` |
| Cold return | `cold-return/after/01-cold-review.png` |
| Trace conclusion | `trace-conclusion/after/01-trail.png`, `03-back-to-writeup.png` |
| No agent | `no-agent/after/` (manual web + fact) |
| Scale | `scale/after/01-inbox-scale.png`, `02-facts-scale.png`, `03-tree-scale.png` |
| Phone | `phone/after/01-inbox-390.png`, `02-facts-390.png`, `03-inbox-after-confirm-390.png` |
| Truth / reject | `truth-reject/after/` |
| Inbox + Trail | `inbox-trail/after/` |

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
| 16 | Crash | API under Review polling | Fixed — Kùzu opt-in; memory serves tree; `\out` no longer `unknown unchecked` | graphIndex / graphScan |

## 5. What I built from section 6

- **Guided review session** on the Trail (progress, Next/Back, j/k/←/→, Escape, “this item is now trusted”).
- **Trust summary** on the Trail header (“Built on N facts… M need attention”).
- **Rejection with reason + undo + impact** on Facts and inbox; **Ask agent to find a new source** clipboard prompt on flagged editors.
- **Provenance badges** on web snapshots.
- Not shipped: SyncTeX PDF review overlay; full activity history; paper “numbers check” panel as a dedicated surface (Trail covers most of it); full 2,000-fact scale (journey uses 400 facts / 80 sources / 40 kn — still stresses lists; bump when you want overnight soak).

## 6. Decisions for you

1. **Paper up-to-date** — Papers are `flagged` whenever cited knowledge/facts are unchecked (stricter than SPEC §5.5). Alternative: keep SPEC and only flag on rejected/flagged.
2. **Block vs warn on step review** — Block with HTTP 409 (`force` available). Alternative: allow with a loud banner.
3. **Reject reason required** — No silent rejects. Alternative: optional reason with a default.
4. **Trail in sidebar** — Files | Trail tabs instead of overlay. Alternative: dedicated right drawer.
5. **Kùzu off by default** — Set `OPENLEAF_KNOWLEDGE_KUZU=1` to re-enable native index writes. Alternative: keep kuzu always on after a harder concurrency fix.

## 7. Known problems left

- SyncTeX PDF review overlay still deferred.
- Scale journey is a reduced synthetic sandbox (400 facts); the brief’s 2k/300/150 target is the next soak.
- Full `npm run e2e` (entire suite beyond journeys) should still be watched on CI for unrelated flakes.
- Canvas `displayLabel` still truncates long names at ~40 chars — hover card shows the full name.
- Keyboard review mode on Facts/inbox (c/r shortcuts) is only partial (guided Trail has j/k).
