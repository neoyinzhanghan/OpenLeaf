import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseTexLog } from "./texLog.js";

const undefinedControl = `
(./main.tex
! Undefined control sequence.
l.12 \\thisisnotamacro
                      {oops}
)
`;

const missingFile = `
(./main.tex
! LaTeX Error: File \`missing-figure.png' not found.

l.4 \\includegraphics{missing-figure.png}
)
`;

const undefinedCitation = `
(./main.tex
LaTeX Warning: Citation \`no-such-key' on page 1 undefined on input line 8.
)
`;

const runaway = `
(./main.tex
! File ended while scanning use of \\@writefile.
<inserted text>
                \\par
l.20 \\end{document}
)
`;

describe("parseTexLog", () => {
  it("reads an undefined control sequence with its line", () => {
    const issues = parseTexLog(undefinedControl);
    const error = issues.find((issue) => issue.severity === "error");
    assert.ok(error);
    assert.match(error.message, /Undefined control sequence/);
    assert.equal(error.line, 12);
    assert.equal(error.file, "main.tex");
  });

  it("reads a missing file", () => {
    const issues = parseTexLog(missingFile);
    const error = issues.find((issue) => issue.severity === "error");
    assert.ok(error);
    assert.match(error.message, /not found/);
    assert.equal(error.line, 4);
  });

  it("reads an undefined citation as a warning", () => {
    const issues = parseTexLog(undefinedCitation);
    const warning = issues.find((issue) => issue.severity === "warning");
    assert.ok(warning);
    assert.match(warning.message, /Citation/);
    assert.equal(warning.line, 8);
  });

  it("reads a runaway argument", () => {
    const issues = parseTexLog(runaway);
    const error = issues.find((issue) => issue.severity === "error");
    assert.ok(error);
    assert.match(error.message, /scanning use/);
    assert.equal(error.line, 20);
  });

  it("keeps a single copy when the same error is printed twice", () => {
    const issues = parseTexLog(`${undefinedControl}\n${undefinedControl}`);
    const errors = issues.filter(
      (issue) => issue.severity === "error" && /Undefined control sequence/.test(issue.message),
    );
    assert.equal(errors.length, 1);
  });

  it("attributes an error inside an input file", () => {
    const log = `
(./main.tex
(./sections/body.tex
! Undefined control sequence.
l.3 \\nope
)
)
`;
    const issues = parseTexLog(log);
    const error = issues.find((issue) => issue.severity === "error");
    assert.ok(error);
    assert.equal(error.file, "sections/body.tex");
    assert.equal(error.line, 3);
  });

  it("uses the main file when the log has not opened a file yet", () => {
    const issues = parseTexLog("! Emergency stop.\nl.1 \\stop\n", { defaultFile: "main.tex" });
    const error = issues.find((issue) => issue.severity === "error");
    assert.ok(error);
    assert.equal(error.file, "main.tex");
    assert.equal(error.line, 1);
  });
});
