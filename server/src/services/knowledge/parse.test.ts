import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseKnowledge, stripComments } from "./parse.js";

describe("parseKnowledge", () => {
  it("strips comments but keeps escaped percent", () => {
    assert.equal(stripComments("a % hide\nb"), "a \nb");
    assert.equal(stripComments("100\\% done"), "100\\% done");
  });

  it("parses title, calculations, assumptions, judgments, conclusion", () => {
    const tex = String.raw`
\documentclass{article}
\usepackage{openleaf-knowledge}
\begin{document}
\begin{knowledge}[result=total]{US market size}
\begin{assumption}[growth]
We assume \set{rate}{0.05} growth.
\end{assumption}
\begin{calculation}{fee}
\fact{fee-per-read}
\end{calculation}
\begin{calculation}[unit=USD, digits=3]{total}
\fact{fee-per-read} \times \kn{us-aspirates} \times (1+\out{rate})
\end{calculation}
\begin{judgment}
This is conservative.
\end{judgment}
\conclusion{The market is about \out{total}.}
\end{knowledge}
\end{document}`;
    const result = parseKnowledge({ "main.tex": tex });
    assert.equal(result.title, "US market size");
    assert.equal(result.resultName, "total");
    assert.ok(result.steps.some((s) => s.id === "assumption:growth"));
    assert.ok(result.steps.some((s) => s.id === "calculation:fee"));
    assert.ok(result.steps.some((s) => s.id === "calculation:total"));
    assert.ok(result.steps.some((s) => s.id === "judgment:1"));
    assert.ok(result.steps.some((s) => s.id === "conclusion"));
    const total = result.steps.find((s) => s.id === "calculation:total")!;
    assert.ok(total.refs.some((r) => r.kind === "fact" && r.key === "fee-per-read"));
    assert.ok(total.refs.some((r) => r.kind === "kn" && r.id === "us-aspirates"));
    assert.ok(total.refs.some((r) => r.kind === "out" && r.name === "rate"));
  });

  it("handles CRLF and nested braces in conclusion", () => {
    const tex = "\\begin{knowledge}{Title}\r\n\\conclusion{Hello {world} ok}\r\n\\end{knowledge}\r\n";
    const result = parseKnowledge({ "main.tex": tex });
    assert.equal(result.title, "Title");
    assert.match(result.conclusion ?? "", /Hello \{world\} ok/);
  });

  it("follows \\input inside the project", () => {
    const result = parseKnowledge(
      {
        "main.tex": "\\begin{knowledge}{T}\\input{body}\\end{knowledge}",
        "body.tex": "\\begin{calculation}{x}1+1\\end{calculation}",
      },
      "main.tex",
    );
    assert.ok(result.steps.some((s) => s.id === "calculation:x"));
  });
});
