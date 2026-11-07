import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractOutNames, knowledgeCursorTarget, wordDiff } from "./knowledgeSupport.js";

describe("knowledgeSupport", () => {
  it("detects fact and kn under the cursor", () => {
    const line = "Market is \\fact{demo-fee-per-read} times \\kn{demo-us-aspirates}.";
    const factCol = line.indexOf("demo-fee") + 1;
    const knCol = line.indexOf("demo-us") + 1;
    assert.deepEqual(knowledgeCursorTarget(line, factCol, 3, [line]), {
      kind: "fact",
      key: "demo-fee-per-read",
      line: 3,
    });
    assert.deepEqual(knowledgeCursorTarget(line, knCol, 3, [line]), {
      kind: "kn",
      id: "demo-us-aspirates",
      line: 3,
    });
  });

  it("detects step from nearby begin", () => {
    const lines = ["\\begin{calculation}{total}", "\\fact{a} \\times 2"];
    const t = knowledgeCursorTarget(lines[1]!, 2, 10, lines);
    assert.equal(t?.kind, "step");
    assert.equal(t && t.kind === "step" ? t.stepId : "", "calculation:total");
  });

  it("wordDiff marks inserts and deletes", () => {
    const d = wordDiff("alpha beta gamma", "alpha delta gamma");
    assert.ok(d.some((x) => x.type === "del" && x.text === "beta"));
    assert.ok(d.some((x) => x.type === "add" && x.text === "delta"));
  });

  it("extracts out names", () => {
    const names = extractOutNames("\\begin{calculation}{total}\\set{base}{1}\\end{calculation}");
    assert.deepEqual(names, ["base", "total"]);
  });
});
