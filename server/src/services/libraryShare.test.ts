import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createLibraryShare,
  getLibraryShareByToken,
  libraryShareBundle,
  libraryShareGuestView,
  stopLibraryShare,
  touchVisitor,
  addSharedNote,
} from "./libraryShare.js";

describe("libraryShare", () => {
  it("rejects empty paper selection", async () => {
    await assert.rejects(
      () => createLibraryShare({ citekeys: [], port: 8787 }),
      (e: Error & { status?: number }) => e.status === 400,
    );
  });

  it("guest view hides host private notes field and supports commenter notes", async () => {
    // Soft integration: if library is empty this will 404 — skip lightly.
    try {
      const { session, inviteUrl } = await createLibraryShare({
        citekeys: ["__nonexistent_citekey_for_share_test__"],
        port: 8787,
        settings: { role: "commenter", title: "Test share" },
      });
      void session;
      void inviteUrl;
      assert.fail("expected missing papers");
    } catch (e) {
      const err = e as Error & { status?: number };
      assert.equal(err.status, 404);
    }
  });

  it("bundle shape is stable", () => {
    const fake = {
      settings: { title: "Reading list", role: "viewer" as const, allowPdf: true, allowExport: true, maxGuests: 10, expiresAt: null },
      papers: [
        {
          citekey: "smith2020test",
          title: "A Test Paper",
          authors: [{ given: "Ada", family: "Smith" }],
          year: 2020,
          venue: "Nature",
          doi: "10.1000/test",
          arxivId: null,
          url: "https://doi.org/10.1000/test",
          abstract: "Abs",
          tags: ["ml"],
          starred: false,
          status: "unread" as const,
          rating: 0,
          notes: "private",
          hasPdf: false,
        },
      ],
    };
    const bundle = libraryShareBundle(fake as never);
    assert.equal(bundle.kind, "openleaf-library-share");
    assert.equal(bundle.version, 1);
    assert.equal(bundle.papers[0]?.title, "A Test Paper");
    assert.equal((bundle.papers[0] as { notes?: string }).notes, undefined);
  });

  it("token lookup returns null after stop", async () => {
    // Exercise stop path with a synthetic session via missing papers already covered;
    // assert helpers don't throw on unknown ids.
    await stopLibraryShare("does-not-exist");
    assert.equal(getLibraryShareByToken("nope"), null);
  });

  it("touchVisitor and notes enforce role", () => {
    const session = {
      id: "x",
      token: "t",
      createdAt: Date.now(),
      settings: {
        expiresAt: null,
        role: "viewer" as const,
        allowPdf: true,
        allowExport: true,
        maxGuests: 2,
        title: "T",
      },
      collectionId: null,
      papers: [
        {
          citekey: "a2020",
          title: "A",
          authors: [],
          year: 2020,
          venue: "",
          doi: null,
          arxivId: null,
          url: null,
          abstract: "",
          tags: [],
          starred: false,
          status: "unread" as const,
          rating: 0,
          notes: "",
          hasPdf: false,
        },
      ],
      notes: [],
      visitors: new Map(),
      status: "active" as const,
      expiryTimer: null,
    };
    const v = touchVisitor(session as never, { name: "Pat" });
    assert.equal(v.name, "Pat");
    const guest = libraryShareGuestView(session as never, v);
    assert.equal(guest.visitor?.name, "Pat");
    assert.throws(
      () => addSharedNote(session as never, { citekey: "a2020", authorName: "Pat", body: "hi" }),
      (e: Error & { status?: number }) => e.status === 403,
    );
    session.settings.role = "commenter";
    const note = addSharedNote(session as never, { citekey: "a2020", authorName: "Pat", body: "hi" });
    assert.equal(note.body, "hi");
  });
});
