import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bibEntryToCreateInput, parseBibtex } from "./bibtex.js";

describe("bibtex arXiv ids", () => {
  it("reads eprint and arxiv.org URLs", () => {
    const [entry] = parseBibtex(`@article{demo,
  title = {Demo},
  eprint = {2401.12345},
  archiveprefix = {arXiv},
  url = {https://arxiv.org/abs/2401.12345}
}
`);
    assert.ok(entry);
    assert.equal(bibEntryToCreateInput(entry).arxivId, "2401.12345");
  });
});
