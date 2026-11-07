import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatFactValue, parseFactValue } from "./factValue.js";

describe("parseFactValue", () => {
  it("parses a plain number", () => {
    assert.deepEqual(parseFactValue("0.91"), { value: 0.91, unit: "" });
  });

  it("strips thousands separators", () => {
    assert.deepEqual(parseFactValue("1,200,000"), { value: 1_200_000, unit: "" });
  });

  it("parses percent as fraction with unit %", () => {
    assert.deepEqual(parseFactValue("88%"), { value: 0.88, unit: "%" });
    assert.deepEqual(parseFactValue("12.5 %"), { value: 0.125, unit: "%" });
  });

  it("takes the first number from ± ranges", () => {
    assert.deepEqual(parseFactValue("0.880 ± 0.057"), { value: 0.88, unit: "" });
  });

  it("handles negatives and scientific notation", () => {
    assert.deepEqual(parseFactValue("-3.2"), { value: -3.2, unit: "" });
    assert.deepEqual(parseFactValue("1.2e3"), { value: 1200, unit: "" });
  });

  it("returns null when there is no number", () => {
    assert.deepEqual(parseFactValue("supported"), { value: null, unit: "" });
    assert.deepEqual(parseFactValue(""), { value: null, unit: "" });
  });

  it("preserves an existing unit when no % is present", () => {
    assert.deepEqual(parseFactValue("412.5", "USD"), { value: 412.5, unit: "USD" });
  });
});

describe("formatFactValue", () => {
  it("formats percent and USD", () => {
    assert.equal(formatFactValue(0.88, "%"), "88%");
    assert.equal(formatFactValue(412.5, "USD"), "$412.5");
  });

  it("returns empty for null", () => {
    assert.equal(formatFactValue(null, ""), "");
  });
});
