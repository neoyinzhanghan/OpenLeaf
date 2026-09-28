# Overnight log — release/ship-ready

Started from `origin/feature/citation-library` at `4d3ba93`.
Neo's dirty working tree on `feature/citation-library` was stashed as `wip on citation-library before release/ship-ready (left untouched)` and was not included.
The live OpenLeaf on port 8787 was not stopped or edited.

## 2026-09-28T08:08Z — branch

- Created `release/ship-ready` from `origin/feature/citation-library`.
- Added `OVERNIGHT_SHIP_BRIEF.md` to `.git/info/exclude` (file is not in the repo).

## 2026-09-28T08:15Z — plan

Priority: P0 security and compile truth, then host access link, then discovery, then P1.
Isolated instances only (`OPENLEAF_PORT` not 8787, separate config and projects dirs).
