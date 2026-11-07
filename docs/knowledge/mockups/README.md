# Mockups

Design references for the Knowledge screens. These are source files from a design tool and will not run on their own
(they load a design runtime). Read them for layout, spacing, colours and copy.

| File | Screen | SPEC section |
|---|---|---|
| `Main.dc.html` | Knowledge item editor (LaTeX source, compiled PDF with review overlay, inspector) | 7.1 |
| `Tree.dc.html` | Knowledge tree. Its `<script>` is a working reference for the force layout, focus, depth, path finding, search, filters, collapse, minimap and labels | 7.2 |
| `Changed.dc.html` | Impact view after a fact is rejected | 7.3 |
| `Review.dc.html` | Review inbox | 7.4 |

`Changed` and `Review` were drawn before the final visual style was settled: match the quieter style of `Main` and
`Tree` when building them. All four use Inter and hard-coded colours; the app must use its own font and theme tokens
(SPEC 7). Numbers in brackets like `[$ per read]` are placeholders, not data.
