import assert from "node:assert/strict";
import test from "node:test";
import { citationLinkAtPoint, citekeyFromPdfDest, type PdfCiteLink } from "./libraryLink.ts";

test("cite dest names become citekeys", () => {
  assert.equal(citekeyFromPdfDest("cite.beware"), "beware");
  assert.equal(citekeyFromPdfDest("cite.Lipton"), "Lipton");
  assert.equal(citekeyFromPdfDest("cite.0@smith.2020"), "smith.2020");
  assert.equal(citekeyFromPdfDest("page.23"), null);
  assert.equal(citekeyFromPdfDest("cite."), null);
  assert.equal(citekeyFromPdfDest(["cite.beware"]), null);
});

test("a click inside a citation rect returns that citekey", () => {
  const links: PdfCiteLink[] = [
    { citekey: "beware", rect: [403.608, 426.011, 409.77, 433.558] },
    { citekey: "Lipton", rect: [88.73, 384.835, 99.062, 392.462] },
  ];
  const pageHeight = 792;
  // PDF y is from the bottom; the viewer click is from the top.
  const yFromTop = pageHeight - 430;
  assert.equal(citationLinkAtPoint(links, 406, yFromTop, pageHeight), "beware");
  assert.equal(citationLinkAtPoint(links, 10, 10, pageHeight), null);
});
