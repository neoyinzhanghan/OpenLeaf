import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  assertLibraryAiOutbound,
  LIBRARY_AI_OUTBOUND_LIMIT,
  LIBRARY_AI_OUTBOUND_WINDOW_MS,
  resetLibraryAiOutboundLimitsForTests,
} from "./libraryAiOutboundLimit.js";

describe("library AI outbound rate limit", () => {
  afterEach(() => {
    resetLibraryAiOutboundLimitsForTests();
  });

  it("allows the cap, then rejects the next call in the same window with 429", () => {
    const start = 1_700_000_000_000;
    for (let i = 0; i < LIBRARY_AI_OUTBOUND_LIMIT; i += 1) {
      assertLibraryAiOutbound("session-a", start + i);
    }
    assert.throws(
      () => assertLibraryAiOutbound("session-a", start + LIBRARY_AI_OUTBOUND_LIMIT),
      (err: unknown) => {
        assert.equal((err as { status?: number }).status, 429);
        assert.match(err instanceof Error ? err.message : "", /too many/i);
        return true;
      },
    );
  });

  it("counts each session separately and opens again after the window", () => {
    const start = 1_700_000_000_000;
    for (let i = 0; i < LIBRARY_AI_OUTBOUND_LIMIT; i += 1) {
      assertLibraryAiOutbound("session-a", start);
    }
    assertLibraryAiOutbound("session-b", start);
    assertLibraryAiOutbound("session-a", start + LIBRARY_AI_OUTBOUND_WINDOW_MS + 1);
  });
});
