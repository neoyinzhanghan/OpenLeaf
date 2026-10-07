import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

const libraryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openleaf-verify-"));
process.env.OPENLEAF_LIBRARY_ROOT = libraryRoot;

const { loadConfig } = await import("../../config.js");
loadConfig(true);

const { setSourceClientsForTests } = await import("./sources/index.js");
const { closeIndexDb, reindexLibrary, addPaper, deletePaper } = await import("./index.js");
const { verifyProposal, addVerifiedPaper } = await import("./verifyProposal.js");
const {
  mintLibraryAi,
  resolveLibraryAiToken,
  revokeLibraryAi,
  listLibraryAiSessions,
} = await import("../libraryAiShare.js");

const realPaper = {
  doi: "10.1000/real.paper",
  arxivId: null as string | null,
  url: "https://doi.org/10.1000/real.paper",
  title: "A Real Calibration Result",
  authors: [{ given: "Ada", family: "Lovelace" }],
  venue: "Journal of Tests",
  year: 2024,
  abstract: "Verified abstract.",
  source: "doi" as const,
};

describe("verifyProposal + library AI mint", () => {
  before(async () => {
    setSourceClientsForTests({
      crossref: {
        lookupDoi: async (doi) => {
          if (doi.includes("not-yet-in-library")) {
            return {
              ...realPaper,
              doi,
              title: "A Paper Not Yet In The Library",
              authors: [{ given: "Grace", family: "Hopper" }],
            };
          }
          if (doi.includes("10.1000/stamp.published")) {
            return {
              ...realPaper,
              doi,
              title: "From Whole-slide Image to Biomarker Prediction Protocol",
              authors: [{ given: "Omar", family: "El Nahhas" }],
              venue: "Nature Protocols",
              year: 2024,
            };
          }
          return doi.includes("10.1000/real") ? { ...realPaper, doi } : null;
        },
      },
      openalex: {
        lookupDoi: async () => null,
        searchByTitle: async (title) => {
          if (title.toLowerCase().includes("real calibration")) return { ...realPaper, source: "manual" };
          return null;
        },
      },
      arxiv: {
        lookupId: async (id) =>
          id.startsWith("2401")
            ? {
                ...realPaper,
                doi: null,
                arxivId: id,
                source: "arxiv" as const,
                title: "Arxiv Real Paper",
                url: `https://arxiv.org/abs/${id}`,
              }
            : null,
      },
    });
    await reindexLibrary();
  });

  after(() => {
    setSourceClientsForTests(null);
    closeIndexDb();
    fs.rmSync(libraryRoot, { recursive: true, force: true });
  });

  it("rejects hallucinated titles and scholar-only URLs", async () => {
    const fake = await verifyProposal({ title: "Completely Invented Paper About Nothing" });
    assert.equal(fake.ok, false);
    if (!fake.ok) assert.equal(fake.code, "HALLUCINATED");

    const scholar = await verifyProposal({
      title: "Anything",
      url: "https://scholar.google.com/scholar?q=foo",
    });
    assert.equal(scholar.ok, false);
    if (!scholar.ok) assert.ok(["UNRESOLVABLE_URL", "HALLUCINATED", "MISSING_TITLE"].includes(scholar.code));
  });

  it("rejects DOI not found and title mismatch", async () => {
    const missing = await verifyProposal({ doi: "10.1000/does.not.exist" });
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.code, "DOI_NOT_FOUND");

    const mismatch = await verifyProposal({
      doi: "10.1000/real.paper",
      title: "Totally Different Title That Does Not Match",
    });
    assert.equal(mismatch.ok, false);
    if (!mismatch.ok) {
      assert.equal(mismatch.code, "TITLE_MISMATCH");
      assert.ok(mismatch.expected?.title);
      assert.ok(mismatch.hint);
    }
  });

  it("accepts arXiv ids", async () => {
    const v = await verifyProposal({ arxivId: "2401.55555" });
    assert.equal(v.ok, true);
    if (v.ok) assert.equal(v.checks.identifier, "arxiv");
  });

  it("accepts an OpenReview forum note and still rejects GitHub", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("api2.openreview.net/notes?id=FNBQOPj18N")) {
        return new Response(
          JSON.stringify({
            notes: [
              {
                id: "FNBQOPj18N",
                cdate: Date.UTC(2024, 6, 1),
                content: {
                  title: { value: "eva: Evaluation framework for pathology foundation models" },
                  authors: { value: ["kaiko.ai", "Ioannis Gatopoulos"] },
                  abstract: { value: "A modular evaluation framework." },
                  venue: { value: "MIDL 2024" },
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("api2.openreview.net/notes?id=BlockedNote1")) {
        return new Response("blocked", { status: 403 });
      }
      return new Response("not found", { status: 404 });
    };

    const ok = await verifyProposal(
      { url: "https://openreview.net/forum?id=FNBQOPj18N" },
      { fetchImpl },
    );
    assert.equal(ok.ok, true);
    if (ok.ok) {
      assert.equal(ok.checks.identifier, "openreview");
      assert.equal(ok.resolved.title, "eva: Evaluation framework for pathology foundation models");
      assert.equal(ok.resolved.authors[0]?.family, "kaiko.ai");
      assert.equal(ok.resolved.authors[1]?.family, "Gatopoulos");
      assert.equal(ok.resolved.year, 2024);
      assert.equal(ok.resolved.url, "https://openreview.net/forum?id=FNBQOPj18N");
    }

    const pdf = await verifyProposal(
      { url: "https://openreview.net/pdf?id=FNBQOPj18N" },
      { fetchImpl },
    );
    assert.equal(pdf.ok, true);

    const github = await verifyProposal({ url: "https://github.com/kaiko-ai/eva" });
    assert.equal(github.ok, false);
    if (!github.ok) assert.equal(github.code, "UNRESOLVABLE_URL");

    const blocked = await verifyProposal(
      { url: "https://openreview.net/forum?id=BlockedNote1" },
      { fetchImpl },
    );
    assert.equal(blocked.ok, false);
    if (!blocked.ok) {
      assert.equal(blocked.code, "UNRESOLVABLE_URL");
      assert.match(blocked.hint, /OpenReview/i);
      assert.match(blocked.reason, /HTTP 403/);
    }
  });

  it("treats a published DOI as a duplicate of the stored preprint", async () => {
    const preprint = await addPaper({
      title: "From Whole-slide Image to Biomarker Prediction Protocol",
      authors: [{ given: "Omar S. M. El", family: "Nahhas" }],
      arxivId: "2312.10944",
      year: 2023,
      venue: "arXiv",
      source: "arxiv",
    });
    const cleanRetractionFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("api.crossref.org/works/")) {
        return new Response(JSON.stringify({ message: { "update-to": [] } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    };
    try {
      const dup = await verifyProposal(
        { doi: "10.1000/stamp.published" },
        { fetchImpl: cleanRetractionFetch },
      );
      assert.equal(dup.ok, false);
      if (!dup.ok) {
        assert.equal(dup.code, "DUPLICATE");
        assert.equal(dup.existingCitekey, preprint.citekey);
      }
    } finally {
      await deletePaper(preprint.citekey);
    }
  });

  it("accepts DOI-only and queues via proposeVerifiedPaper", async () => {
    // Real Crossref update-to check now runs pre-add (fixed: it used to be a
    // stub that always returned "clean" without ever calling Crossref) —
    // mock the retraction lookup the same way integrity.test.ts does, so
    // this test doesn't depend on reaching the real network.
    const cleanRetractionFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("api.crossref.org/works/")) {
        return new Response(
          JSON.stringify({ message: { title: ["A Real Calibration Result"], "update-to": [] } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    };

    const v = await verifyProposal({ doi: "10.1000/real.paper" }, { fetchImpl: cleanRetractionFetch });
    assert.equal(v.ok, true);

    const { proposeVerifiedPaper } = await import("./verifyProposal.js");
    const proposed = await proposeVerifiedPaper(
      { doi: "10.1000/real.paper" },
      { fetchImpl: cleanRetractionFetch },
    );
    assert.equal(proposed.ok, true);
    if (proposed.ok) assert.equal(proposed.decision, "pending");

    const added = await addVerifiedPaper(
      { doi: "10.1000/real.paper" },
      { fetchImpl: cleanRetractionFetch },
    );
    assert.equal(added.ok, true);
    if (added.ok) {
      assert.equal(added.created, true);
      assert.equal(added.paper.doi, "10.1000/real.paper");
    }

    const dup = await verifyProposal({ doi: "10.1000/real.paper" }, { fetchImpl: cleanRetractionFetch });
    assert.equal(dup.ok, false);
    if (!dup.ok) assert.equal(dup.code, "DUPLICATE");
  });

  it("rejects (fail-closed) when the retraction check itself fails, instead of fabricating 'clean'", async () => {
    // Regression: checkRetraction used to swallow every outcome (hit, miss,
    // network error) into "clean" without ever calling Crossref. Now a
    // genuine HTTP failure propagates and verifyProposal rejects rather than
    // silently reporting an unretracted paper as checked-and-clean.
    const brokenFetch: typeof fetch = async () => new Response("server error", { status: 500 });
    await assert.rejects(
      () =>
        verifyProposal(
          { doi: "10.1000/real.paper.not-yet-in-library" },
          { fetchImpl: brokenFetch },
        ),
      (e: unknown) => {
        assert.match((e as Error).message, /crossref/i);
        return true;
      },
    );
  });

  it("queues library AI proposals for host Accept/Reject", async () => {
    const { enqueueLibraryProposal, listPendingLibraryProposals, acceptLibraryProposal, rejectLibraryProposal } =
      await import("../libraryAiReview.js");
    const minted = mintLibraryAi({
      riskAck: true,
      ttlMinutes: 60,
      settings: { title: "Review test" },
      port: 8787,
    });
    const proposed = await (await import("./verifyProposal.js")).proposeVerifiedPaper({
      arxivId: "2401.99991",
    });
    assert.equal(proposed.ok, true);
    if (!proposed.ok) return;
    const pending = enqueueLibraryProposal(minted.session, proposed.proposal, proposed.verify);
    assert.equal(listPendingLibraryProposals().some((p) => p.id === pending.id), true);
    assert.equal(rejectLibraryProposal(pending.id), true);
    assert.equal(listPendingLibraryProposals().some((p) => p.id === pending.id), false);

    const again = enqueueLibraryProposal(minted.session, proposed.proposal, proposed.verify);
    const accepted = await acceptLibraryProposal(again.id);
    assert.ok(accepted.paper.arxivId);
    revokeLibraryAi(minted.session.id);
  });

  it("mints and resolves library AI tokens with riskAck", () => {
    assert.throws(() => mintLibraryAi({ riskAck: false as unknown as true }), (e: unknown) => {
      assert.ok(e instanceof Error);
      assert.equal((e as { status?: number }).status, 400);
      return true;
    });

    const minted = mintLibraryAi({
      riskAck: true,
      ttlMinutes: 60,
      settings: { title: "Lit review", maxAdds: 5 },
      port: 8787,
    });
    assert.match(minted.libraryAiUrl, /\/library-ai\//);
    assert.match(minted.starterPrompt, /library_verify|POST \/verify/);
    assert.match(minted.starterPrompt, /Authorization: Bearer/);
    assert.match(minted.mcpConfig, /Authorization/);
    assert.match(minted.cursorPrompt, /library_verify/);
    assert.match(minted.cursorPrompt, /credential exfiltration/);
    assert.equal(minted.cursorPrompt.includes(minted.session.token), false);
    assert.equal(minted.cursorPrompt.includes("Authorization: Bearer"), false);

    const auth = resolveLibraryAiToken(minted.session.token);
    assert.ok(auth);
    assert.equal(auth!.session.settings.title, "Lit review");
    assert.equal(listLibraryAiSessions().length >= 1, true);

    revokeLibraryAi(minted.session.id);
    assert.equal(resolveLibraryAiToken(minted.session.token), null);
  });

  it("still allows manual addPaper without AI gate", async () => {
    const paper = await addPaper({
      title: "Manual Local Note",
      source: "manual",
      authors: [{ family: "Host" }],
    });
    assert.ok(paper.citekey);
  });
});
