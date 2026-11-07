import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import {
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

  it("aggregates item and project status", () => {
    assert.equal(computeItemStatus({ steps: [{ status: "reviewed" }], hasErrors: false }), "reviewed");
    assert.equal(computeItemStatus({ steps: [{ status: "flagged" }], hasErrors: false }), "flagged");
    assert.equal(computeProjectStatus(["reviewed", "flagged"]), "flagged");
    assert.equal(computeProjectStatus(["confirmed", "reviewed"]), "up-to-date");
  });
});
