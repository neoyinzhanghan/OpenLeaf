# Authoring knowledge items (for agents)

Knowledge items are ordinary OpenLeaf projects with `"kind": "knowledge"` in `openleaf.json`. They compile with the `openleaf-knowledge` package.

## Rules

1. **Every number in a calculation must come from** `\fact{…}`, `\kn{…}`, `\out{…}`, or a `\set{name}{number}` inside an `assumption` / `judgment`.
2. **Never type a raw statistic you did not get from a source.** Propose facts with exact quotes via `fact_propose`.
3. **Only a human can confirm, reject, or mark a step reviewed.** There is no MCP tool for verification. Agent-created facts are always `unreviewed`.

## Macros

| Macro | Meaning |
|---|---|
| `\fact{key}` | Fact display / numeric value inside calculations |
| `\kn{id}` / `\kn[name]{id}` | Another item’s primary or named output |
| `\knref{id}` | Item title |
| `\out{name}` | A value defined in this item |
| `\conclusion{…}` | Shaded conclusion block |
| `\begin{calculation}[unit=…, digits=…]{name}…\end{calculation}` | Named calculation |
| `\begin{assumption}[id]…\end{assumption}` / `\begin{judgment}[id]…` | Reviewed prose steps; use `\set{name}{n}` inside |

## Proposing facts

Use `fact_propose` with `quotes[]` that appear **verbatim** in the source PDF text or web `snapshot.txt`. If a quote is missing, the call fails. Always pass `agentName` so the review inbox can group your session.

## Web sources

`source_add_web` fetches a page (server-side, with private-IP refusal) and stores `snapshot.txt` (+ optional `snapshot.html` for provenance, never served as HTML).

## Checking

`knowledge_check` parses and evaluates an item and returns errors/statuses. `knowledge_create` scaffolds a new item; then edit its `.tex` files directly.
