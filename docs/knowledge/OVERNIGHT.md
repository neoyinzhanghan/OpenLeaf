# Overnight brief: make the review system something the owner trusts and enjoys

You have the whole night. The owner will be asleep and will not answer questions. Do not stop after the obvious fixes.
Keep working until the morning report (section 8) is complete and every journey in section 4 runs smoothly end to end.

## 1. What the owner will judge you on

One question: **can he take a real research question from "my agent found some sources" all the way to "I trust this
number in my paper", smoothly, and does OpenLeaf tell him the truth at every step?**

"The truth" means: at any moment, on any screen, he can see whether something is checked, what it depends on, what is
wrong upstream, and what he should do next. A number built on a rejected fact must never look fine anywhere.

He finds it hard to say exactly what is missing. That is your job tonight: use the product the way he would, find every
place where the flow breaks, confuses, dead-ends, lies, or simply feels clumsy, and fix it. Think like a demanding
product designer and a QA engineer at once.

Scope is the whole loop: **Sources → Facts → Knowledge items (steps) → Papers**, across the Library, Facts, Knowledge
tree, Review inbox, the knowledge editor (header, Trail, inspector, PDF), paper editors that cite knowledge, and the
agent (MCP) path that feeds all of it.

## 2. Ground truth: what a 30-minute walkthrough of `knowledge-v1` already found

Reproduced on a fresh sandbox with `npm run seed:knowledge-demo`, production build, Chromium at 1440×900. Treat these as
the first items, not the whole list. Each fix needs a test that would have caught it.

### Truth bugs (fix first)

1. **A rejected fact disappears from view as soon as anything downstream is unreviewed.** Reject `demo-fee-per-read` on
   the Facts page. Then `GET /api/knowledge/graph`: `kn:demo-us-market-size` is `needs-review` with `why: []`, and
   `proj:demo-paper-citing-knowledge` is `up-to-date` with `why: []`. The paper keeps printing the market number with no
   warning. Root cause in `server/src/services/knowledge/status.ts`: `computeStepStatus` returns `needs-review` before
   looking at inputs, so the rejection reason is dropped; `computeProjectStatus` only reacts to `rejected`/`flagged`
   upstream, so a paper citing unreviewed or compromised knowledge reads as fine. Fix the model so upstream problems are
   always carried as reasons regardless of review state (for example, a status plus separate "upstream problems"), and a
   paper is only "up to date" when everything it cites is checked and clean. Show this everywhere: editor header, Trail,
   inspector, PDF overlay or banner, tree, inbox, project list.
2. **You can mark a step "reviewed" while its input is rejected**, with no warning. The step inspector shows only the raw
   LaTeX: no inputs, no values, no statuses. A step review must show each input with its value, status and source, and
   warn (or block, with a clear explanation) when an input is rejected or unchecked.
3. **The Review inbox misses most of what needs review.** With two knowledge items and four steps needing review, the
   inbox listed only the rejected facts; the nav badge count disagrees with the tree panel. Rejected facts appear under
   "Flagged" with a teal (looks-fine) dot. The inbox must contain everything that needs the owner, grouped sensibly, with
   counts that match every other screen.
4. **Rejecting a fact shows no impact.** SPEC 7.3: after a rejection the owner must immediately see what it affects.
   On the Facts page nothing appears. Also no reason is captured on reject and there is no undo.
5. **Compile is not deterministic.** The first compile of "DEMO US market size for DeepHeme" failed with `Missing $
   inserted` at `main.tex:6–7` (the `calculation` body); a later compile succeeded. `openleaf-knowledge.sty` typesets the
   calculation body in text mode, so `\times` breaks depending on what the values file defines at that moment. Typeset
   expressions in math mode, make a first compile of a fresh item always succeed, and add a compile test that uses
   `\times`, `\frac`, and a `\kn` to an item that has never been compiled.
6. **Numbers are unreadable**: `1.00e+5`, `4.13e+7`, `412.5^f` in the PDF and UI. Use human formatting (SPEC 5.4:
   significant digits, thousands separators, units, `$41.3 million` style where sensible), consistently in PDF and UI.
7. **The PDF's "Built on" section is a placeholder sentence.** It must list the actual facts (statement, value, source,
   page or URL, saved date) and knowledge items used.
8. **Provenance can be invented.** `scripts/seed-deephome-market.mts` writes "curated excerpt" snapshots when a live
   fetch is blocked. A snapshot that OpenLeaf did not fetch itself must be labelled as such everywhere it appears
   (source, fact, trail, inbox), and the owner must be able to tell "fetched by OpenLeaf on <date>" from "text pasted by
   an agent" from "uploaded by you". Check whether the snapshot `note` is shown anywhere today; it does not appear to be.
   The same script also crashes with `ENOTFOUND` when offline instead of skipping cleanly.

### Flow and clarity problems

9. Knowledge tree opens with the camera not fitted: nodes and labels cut off at the left edge ("EMO US market…").
   Canvas labels are much larger than the rest of the UI. In focus view the paper node has no label. The trail list
   truncates names to "DEM…", which is unreadable.
10. The editor inspector is a translucent card over the bottom right of the PDF with very low contrast text. For a
    `\kn{}` it says "Open this item from the Knowledge tree to review its steps" — a dead end; it should open the item.
11. Two entry points fight each other: the header "Review trail" button and the sidebar "Trail" tab toggle each other in
    confusing ways. "Back to write-up" appears while the write-up is already visible.
12. Step review is not discoverable: you only find it by clicking inside an environment. The gutter markers are not
    clickable, and the "2 of 2 steps need review" chip does nothing when clicked.
13. The Trail shows a source with an "OK" badge (sources are not reviewed) and raw citekeys like `anon2026demo`.
14. Facts page: the default "Unreviewed 0" view is a blank half-screen with no guidance; the disabled Reject button is
    nearly invisible; Confirm and Reject are small for the most important action on the page.
15. Library lists a web source as "Unknown authors · Unchecked", which is meaningless for a web page.

## 3. How to work

- **Branch.** Create `knowledge-review-ux` from `knowledge-v1`. Small commits, each with a clear message. Push the
  branch. Never touch `main` or `knowledge-v1`, never force-push.
- **Sandbox only.** Never read or write the owner's real `projects/` or `library/`. Run everything with
  `OPENLEAF_CONFIG_DIR`, `OPENLEAF_PROJECTS_ROOT`, `OPENLEAF_LIBRARY_ROOT` pointing at temp folders (see
  `e2e/instance.ts`), `OPENLEAF_HOST_GATEWAY=0`, and `OPENLEAF_ALLOW_PRIVATE_FETCH=1` with a local static server for test
  web pages. No internet access is required or assumed.
- **Use it like the owner.** For each journey in section 4, write a Playwright script under `e2e/journeys/` that drives
  the real UI (no API shortcuts except to set up data), takes a screenshot after every meaningful step, and saves them
  to `docs/knowledge/morning/<journey>/before/` the first time and `after/` once fixed. Look at every screenshot yourself
  and write down everything that is wrong, unclear, ugly, slow, inconsistent or missing. Then fix, re-run, look again.
  The scripts stay as regression tests.
- **Loop:** walk → list problems → fix the worst → add a test → re-walk → commit. After every fix run `npm run
  typecheck`, `npm test`, and the affected Playwright specs; at least every two hours run the full `npm run e2e`.
- **Priorities:** truth bugs, then broken or dead-end flows, then confusing flows, then polish, then new ideas.
  Time-box any single problem to about 45 minutes; if stuck, log it with evidence and move on, then come back.
- **Decide, don't ask.** When a design choice is unclear, choose the option that best serves section 1, log it in
  `docs/knowledge/DECISIONS.md`, and keep going. If it is a big call the owner should make, implement your recommended
  option and list it in the morning report under "Decisions for you".

## 4. Journeys to walk (all of them, more than once)

1. **Agent research to a trusted number.** Through the MCP tools only (as Cursor or Claude Code would): add three web
   sources and one PDF, propose eight facts with exact quotes, create a knowledge item with a calculation, an assumption
   and a judgment call that uses another knowledge item. Then, as the owner, starting from the Review inbox, review
   everything until the item is fully trusted; cite it with `\kn{}` in a paper; compile. Measure clicks and dead ends.
2. **Something is wrong.** In the middle of journey 1's result, discover a wrong number (an agent took accuracy instead
   of AUC). Reject it with a reason, see exactly what it affects, replace it with the correct fact (find it in the source
   or ask the agent with a ready-made instruction), and re-review only what actually needs it, until the paper is clean
   again. Nothing downstream may look fine while the bad number is in play.
3. **Coming back after a week.** Open OpenLeaf cold. Can the owner tell in ten seconds what changed, what needs him,
   and where he left off?
4. **Understanding a conclusion.** From a paper's number, trace back through knowledge and facts to the highlighted
   passage in the source, and return to where you started without losing your place.
5. **No agent at all.** Add a PDF, tag a fact by drawing a box, add a web page by URL, write a knowledge item by hand
   using completions and hovers, review it.
6. **Scale.** Generate a synthetic sandbox library (2,000 facts across 300 sources, 150 knowledge items with chains up
   to depth 6, 10 papers; some rejected and unreviewed). Inbox, Facts, tree and editor must stay usable and fast.
   Never generate this into a real library.
7. **Phone width (390px).** Confirm and reject a fact and clear a few inbox items on a phone.

## 5. Every nook and cranny: the audit checklist

For each screen and each journey step, check and fix:

- **One vocabulary, one colour system.** Status words, icons and colours mean exactly the same thing on every screen
  (Facts, Library, Trail, inspector, tree, inbox, project list, editor header, PDF). A rejected thing is never teal.
- **Counts agree** across nav badges, page headers, panels and tree.
- **Every item links to every place it appears**, and back: fact ↔ source passage ↔ knowledge steps using it ↔ papers
  citing those ↔ tree node ↔ inbox row. No dead ends, no "go find it elsewhere" messages.
- **The next action is always obvious.** Every view that shows a problem offers the action that fixes it.
- **Why is always available.** Any non-clean status explains itself in one plain sentence, naming the upstream cause.
- **States:** empty (with guidance), loading, error (with a way out), very long names, very many items, deleted
  sources, renamed fact keys and projects, a compile that fails, an item with no steps, a cycle.
- **Undo** for confirm, reject and review, or at least an easy way to reverse with history kept.
- **Keyboard:** a fast review mode with shortcuts (next, confirm, reject, open source) and visible hints.
- **Plain English copy.** No citekeys, internal ids or jargon in primary text; short sentences; no hype.
- **Every theme** (there are many in `client/src/styles.css`), light and dark, readable contrast; phone width.
- **No console errors**, no layout shifts, no overlapping panels, nothing covering the PDF or the editor.
- **Performance:** interactions under 100 ms, pages under 1.5 s on the scale sandbox.

## 6. Ideas worth trying (build the ones that make the journeys clearly better)

- A **guided review session**: walk the owner through everything an item depends on in the right order (sources'
  facts first, then steps, then the conclusion), one card at a time, source passage beside it, keyboard driven,
  with a progress bar and a clear "this item is now trusted" moment.
- A **trust summary** on every knowledge item and paper: "Built on 12 facts from 5 sources. 10 checked, 1 unchecked,
  1 rejected. 3 of 4 steps reviewed." Clickable to the exact gaps.
- **Rejection with a reason** and a **replace** flow: pick another fact, find the right passage in the same source, or
  copy a ready-made instruction for an agent.
- **"What changed since you last looked"** for returning sessions, and an activity history per fact and step (who,
  when, what changed, old → new value).
- **Provenance badges** on sources and facts: fetched by OpenLeaf, uploaded by you, pasted by an agent; snapshot date;
  link health.
- **Review status inside the PDF** (finish the SyncTeX overlay that was left as a blocker) so the owner can review
  while reading the write-up.
- In a paper, a **numbers check**: every `\kn` and `\fact` used, with its trust state, in one panel.

You may change layouts, flows and copy substantially. You may not: change data formats in a way that breaks existing
files, remove existing features, give agents any way to verify anything, fabricate data or snapshots, or add heavy
dependencies.

## 7. Quality bar for every change

- A test that fails before the fix and passes after (unit, integration or journey).
- `npm run typecheck`, `npm test`, `npm run build` clean; touched Playwright specs green; full e2e green at the end,
  three runs in a row.
- Screenshots before and after for anything visible.

## 8. The morning report: `docs/knowledge/MORNING_REPORT.md`

Write it as you go and finish it before you stop. Plain English, scannable.

1. **Five-line summary** of what is better.
2. **Try this first:** three to five steps on the demo seed that show the biggest improvement.
3. **Before / after:** the key screenshots side by side for each journey (images in `docs/knowledge/morning/`).
4. **Issues table:** every problem found (including the fifteen above): severity, screen, status (fixed / not fixed),
   commit.
5. **What I built** from section 6, and ideas I did not get to, each with one sentence on why it matters.
6. **Decisions for you** (at most five), each with the option I implemented and the alternative.
7. **Known problems left**, with evidence and what would fix them.
