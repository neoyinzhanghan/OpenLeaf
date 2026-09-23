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
const { closeIndexDb, reindexLibrary, addPaper } = await import("./index.js");
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
        lookupDoi: async (doi) => (doi.includes("10.1000/real") ? { ...realPaper, doi } : null),
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

  it("accepts DOI-only and queues via proposeVerifiedPaper", async () => {
    const v = await verifyProposal({ doi: "10.1000/real.paper" });
    assert.equal(v.ok, true);

    const { proposeVerifiedPaper } = await import("./verifyProposal.js");
    const proposed = await proposeVerifiedPaper({ doi: "10.1000/real.paper" });
    assert.equal(proposed.ok, true);
    if (proposed.ok) assert.equal(proposed.decision, "pending");

    const added = await addVerifiedPaper({ doi: "10.1000/real.paper" });
    assert.equal(added.ok, true);
    if (added.ok) {
      assert.equal(added.created, true);
      assert.equal(added.paper.doi, "10.1000/real.paper");
    }

    const dup = await verifyProposal({ doi: "10.1000/real.paper" });
    assert.equal(dup.ok, false);
    if (!dup.ok) assert.equal(dup.code, "DUPLICATE");
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
    assert.match(minted.mcpConfig, /Authorization/);

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
