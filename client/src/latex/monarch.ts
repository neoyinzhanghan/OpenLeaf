import type { languages } from "monaco-editor";

/**
 * Monarch tokenizer for LaTeX — colors commands, math, comments, envs, etc.
 */
export const latexMonarch: languages.IMonarchLanguage = {
  defaultToken: "",
  ignoreCase: false,
  tokenizer: {
    root: [
      [/%.*$/, "comment"],
      [/\$\$/, "delimiter.math", "@displayMath"],
      [/\$/, "delimiter.math", "@inlineMath"],
      [/\\\[/, "delimiter.math", "@displayMathBracket"],
      [/\\\(/, "delimiter.math", "@inlineMathParen"],

      [/\\begin\{[^}]*\}/, "keyword.environment"],
      [/\\end\{[^}]*\}/, "keyword.environment"],

      [
        /\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?/,
        "keyword.section",
      ],
      [/\\(documentclass|usepackage|input|include)\b/, "keyword.package"],
      [/\\(label|ref|eqref|pageref|cite|citep|nocite)\b/, "keyword.reference"],
      [/\\(textbf|textit|texttt|emph|underline|textsc|textsf)\b/, "keyword.formatting"],
      [/\\[a-zA-Z@]+\*?/, "keyword"],
      [/\\[@|!$%&\-{}$#,~^\\ _]/, "keyword.escape"],

      [/[{}]/, "@brackets"],
      [/[[\]]/, "@brackets"],
      [/[0-9]*\.?[0-9]+/, "number"],
      [/[&~^_]/, "operator"],
    ],

    inlineMath: [
      [/\$/, "delimiter.math", "@pop"],
      [/%.*$/, "comment"],
      [/\\[a-zA-Z@]+\*?/, "keyword.math"],
      [/\\[@|!$%&\-{}$#,~^\\ _]/, "keyword.escape"],
      [/[{}]/, "@brackets"],
      [/./, "string.math"],
    ],

    displayMath: [
      [/\$\$/, "delimiter.math", "@pop"],
      [/%.*$/, "comment"],
      [/\\[a-zA-Z@]+\*?/, "keyword.math"],
      [/\\[@|!$%&\-{}$#,~^\\ _]/, "keyword.escape"],
      [/[{}]/, "@brackets"],
      [/./, "string.math"],
    ],

    displayMathBracket: [
      [/\\\]/, "delimiter.math", "@pop"],
      [/%.*$/, "comment"],
      [/\\[a-zA-Z@]+\*?/, "keyword.math"],
      [/\\[@|!$%&\-{}$#,~^\\ _]/, "keyword.escape"],
      [/[{}]/, "@brackets"],
      [/./, "string.math"],
    ],

    inlineMathParen: [
      [/\\\)/, "delimiter.math", "@pop"],
      [/%.*$/, "comment"],
      [/\\[a-zA-Z@]+\*?/, "keyword.math"],
      [/\\[@|!$%&\-{}$#,~^\\ _]/, "keyword.escape"],
      [/[{}]/, "@brackets"],
      [/./, "string.math"],
    ],
  },
};

export const bibtexMonarch: languages.IMonarchLanguage = {
  defaultToken: "",
  tokenizer: {
    root: [
      [/%.*$/, "comment"],
      [/@[a-zA-Z]+/, "keyword"],
      [/[{}]/, "@brackets"],
      [/=/, "operator"],
      [/"[^"]*"/, "string"],
      [/\{[^}]*\}/, "string"],
      [/[a-zA-Z0-9_.:\-]+/, "identifier"],
    ],
  },
};
