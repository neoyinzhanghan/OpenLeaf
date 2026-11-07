import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import {
  collectUpstreamWhy,
  computeItemStatus,
  computeProjectStatus,
  computeStepStatus,
  normalizeStepText,
} from "./status.js";

function hash(s: string): string {
  return createHash("sha256").update(normalizeStepText(s)).digest("hex");
}

describe("status engine", () => {
  it("returns needs-review when hash differs", () => {
    const text = "a + b";
    const st = computeStepStatus({
      id: "calculation:x",
      textHash: hash(text + " changed"),
      review: { hash: hash(text), verdict: "reviewed" },
      inputStatuses: [],
    });
    assert.equal(st.status, "needs-review");
  });

  it("flags when an input is rejected", () => {
    const text = "\\fact{fee}";
    const h = hash(text);
    const st = computeStepStatus({
      id: "calculation:x",
      textHash: h,
      review: { hash: h, verdict: "reviewed" },
      inputStatuses: [{ id: "fact:fee", status: "rejected" }],
    });
    assert.equal(st.status, "flagged");
    assert.ok(st.why.some((w) => /rejected/.test(w)));
  });

  it("carries rejected-input why even when the step itself still needs review", () => {
    const st = computeStepStatus({
      id: "calculation:x",
      textHash: hash("\\fact{fee}"),
      review: null,
      inputStatuses: [{ id: "fact:demo-fee-per-read", status: "rejected" }],
    });
    assert.equal(st.status, "needs-review");
    assert.ok(st.why.some((w) => /fact:demo-fee-per-read rejected/.test(w)));
    assert.ok(st.why.some((w) => /not reviewed yet/.test(w)));
  });

  it("aggregates item why from steps", () => {
    const item = computeItemStatus({
      steps: [
        { status: "needs-review", why: ["not reviewed yet", "fact:fee rejected"] },
        { status: "needs-review", why: ["not reviewed yet"] },
      ],
      hasErrors: false,
    });
    assert.equal(item.status, "needs-review");
    assert.ok(item.why.some((w) => /fact:fee rejected/.test(w)));
  });

  it("flags a paper when upstream knowledge still needs review", () => {
    const paper = computeProjectStatus(["needs-review"]);
    assert.equal(paper.status, "flagged");
    assert.ok(paper.why.some((w) => /unchecked/.test(w)));
  });

  it("flags a paper when upstream is rejected", () => {
    const paper = computeProjectStatus(["reviewed", "rejected"]);
    assert.equal(paper.status, "flagged");
    assert.ok(paper.why.some((w) => /rejected/.test(w)));
  });

  it("is up-to-date only when every upstream is clean", () => {
    assert.equal(computeProjectStatus(["confirmed", "reviewed"]).status, "up-to-date");
    assert.equal(computeProjectStatus(["unreviewed"]).status, "flagged");
  });

  it("collectUpstreamWhy names unchecked inputs", () => {
    const why = collectUpstreamWhy([
      { id: "fact:a", status: "unreviewed" },
      { id: "kn:b", status: "needs-review" },
    ]);
    assert.deepEqual(why, ["fact:a unchecked", "kn:b unchecked"]);
  });

  it("does not flag a reviewed step whose only extra input is a clean \\out", () => {
    const text = "Headline is \\out{headline}.";
    const h = hash(text);
    const st = computeStepStatus({
      id: "conclusion",
      textHash: h,
      review: { hash: h, verdict: "reviewed" },
      inputStatuses: [{ id: "out:headline", status: "reviewed" }],
    });
    assert.equal(st.status, "reviewed");
    assert.deepEqual(st.why, []);
  });
});
