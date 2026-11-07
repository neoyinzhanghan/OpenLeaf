import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  evaluateExpression,
  evaluateKnowledgeGraph,
  formatKnowledgeNumber,
} from "./evaluate.js";

describe("evaluateExpression", () => {
  const ctx = {
    resolve: (ref: { kind: string; key?: string; id?: string; name?: string }) => {
      if (ref.kind === "fact" && ref.key === "fee") return { kind: "fact" as const, key: "fee", value: 10 };
      if (ref.kind === "fact" && ref.key === "none") return { kind: "fact" as const, key: "none", value: null };
      if (ref.kind === "fact" && ref.key === "bad")
        return { kind: "fact" as const, key: "bad", value: 1, rejected: true };
      if (ref.kind === "out" && ref.name === "rate") return { kind: "out" as const, name: "rate", value: 0.1 };
      if (ref.kind === "kn" && ref.id === "asp") return { kind: "kn" as const, id: "asp", value: 100 };
      return null;
    },
  };

  it("evaluates arithmetic and refs", () => {
    const r = evaluateExpression(String.raw`\fact{fee} \times \kn{asp} \times (1+\out{rate})`, ctx);
    assert.equal(r.errors.length, 0);
    assert.equal(r.value, 1100);
  });

  it("handles frac, unary minus, thousands separators", () => {
    assert.equal(evaluateExpression(String.raw`\frac{1,200}{10}`, ctx).value, 120);
    assert.equal(evaluateExpression("-3+5", ctx).value, 2);
    assert.equal(evaluateExpression("2^3", ctx).value, 8);
  });

  it("errors on unknown / non-numeric facts and flags rejected", () => {
    const missing = evaluateExpression(String.raw`\fact{missing}`, ctx);
    assert.ok(missing.errors.length);
    const none = evaluateExpression(String.raw`\fact{none}`, ctx);
    assert.ok(none.errors.some((e) => /no numeric value/i.test(e.message)));
    const bad = evaluateExpression(String.raw`\fact{bad}+1`, ctx);
    assert.equal(bad.value, 2);
    assert.equal(bad.flagged, true);
  });
});

describe("formatKnowledgeNumber", () => {
  it("formats percent and USD", () => {
    assert.equal(formatKnowledgeNumber(0.88, { unit: "%" }), "88%");
    assert.match(formatKnowledgeNumber(412.5, { unit: "USD" }), /^\$/);
  });
});

describe("evaluateKnowledgeGraph", () => {
  it("evaluates a two-item chain and reports cycles", () => {
    const facts = new Map([["fee", { value: 2 }]]);
    const ok = evaluateKnowledgeGraph(
      [
        {
          knowledgeId: "a",
          resultName: "x",
          dependsOn: [],
          steps: [{ id: "calculation:x", kind: "calculation", name: "x", body: "\\fact{fee}*3", sets: [] }],
        },
        {
          knowledgeId: "b",
          resultName: "y",
          dependsOn: ["a"],
          steps: [{ id: "calculation:y", kind: "calculation", name: "y", body: "\\kn{a}+1", sets: [] }],
        },
      ],
      facts,
    );
    assert.equal(ok.get("a")!.primary, 6);
    assert.equal(ok.get("b")!.primary, 7);

    const cyc = evaluateKnowledgeGraph(
      [
        {
          knowledgeId: "p",
          resultName: "x",
          dependsOn: ["q"],
          steps: [{ id: "calculation:x", kind: "calculation", name: "x", body: "\\kn{q}", sets: [] }],
        },
        {
          knowledgeId: "q",
          resultName: "y",
          dependsOn: ["p"],
          steps: [{ id: "calculation:y", kind: "calculation", name: "y", body: "\\kn{p}", sets: [] }],
        },
      ],
      facts,
    );
    assert.ok(cyc.get("p")!.errors.some((e) => /circular/i.test(e.message)));
    assert.ok(cyc.get("q")!.errors.some((e) => /circular/i.test(e.message)));
  });
});
