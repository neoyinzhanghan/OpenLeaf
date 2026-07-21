import type { Monaco } from "@monaco-editor/react";
import { createCompletionProvider, type LatexSuggestContext } from "./completions";
import { bibtexMonarch, latexMonarch } from "./monarch";

const LANGUAGE_ID = "latex";
const BIB_ID = "bibtex";
const THEME_ID = "openleaf-latex";
const THEME_ID_DARK = "openleaf-latex-dark";

let registered = false;
let contextProvider: () => LatexSuggestContext = () => ({
  citations: [],
  labels: [],
});

export function setLatexSuggestContext(getContext: () => LatexSuggestContext): void {
  contextProvider = getContext;
}

/**
 * Register LaTeX + BibTeX languages, theme, and completions once per Monaco instance.
 */
export function registerLatexLanguage(monaco: Monaco): void {
  if (registered) return;
  registered = true;

  monaco.languages.register({
    id: LANGUAGE_ID,
    extensions: [".tex", ".sty", ".cls"],
    aliases: ["LaTeX", "TeX"],
  });
  monaco.languages.register({
    id: BIB_ID,
    extensions: [".bib"],
    aliases: ["BibTeX"],
  });

  monaco.languages.setLanguageConfiguration(LANGUAGE_ID, {
    comments: { lineComment: "%" },
    brackets: [
      ["{", "}"],
      ["[", "]"],
      ["(", ")"],
    ],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: "$", close: "$" },
      { open: "`", close: "'" },
    ],
    surroundingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: "$", close: "$" },
    ],
    folding: {
      markers: {
        start: /^\s*\\begin\{/,
        end: /^\s*\\end\{/,
      },
    },
    indentationRules: {
      increaseIndentPattern: /\\begin\{(?!document)[^}]*\}?\s*$/,
      decreaseIndentPattern: /^\s*\\end\{/,
    },
  });

  monaco.languages.setLanguageConfiguration(BIB_ID, {
    comments: { lineComment: "%" },
    brackets: [
      ["{", "}"],
      ["(", ")"],
    ],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: '"', close: '"' },
    ],
  });

  monaco.languages.setMonarchTokensProvider(LANGUAGE_ID, latexMonarch);
  monaco.languages.setMonarchTokensProvider(BIB_ID, bibtexMonarch);

  monaco.languages.registerCompletionItemProvider(
    LANGUAGE_ID,
    createCompletionProvider(monaco, () => contextProvider()),
  );

  // Overleaf-adjacent palette: teal commands, amber math, muted comments
  monaco.editor.defineTheme(THEME_ID, {
    base: "vs",
    inherit: true,
    rules: [
      { token: "comment", foreground: "6B7C8F", fontStyle: "italic" },
      { token: "keyword", foreground: "0F766E", fontStyle: "bold" },
      { token: "keyword.environment", foreground: "0B5FFF", fontStyle: "bold" },
      { token: "keyword.section", foreground: "9A3412", fontStyle: "bold" },
      { token: "keyword.package", foreground: "7C3AED" },
      { token: "keyword.reference", foreground: "C2410C" },
      { token: "keyword.formatting", foreground: "0369A1" },
      { token: "keyword.math", foreground: "B45309" },
      { token: "keyword.escape", foreground: "0F766E" },
      { token: "delimiter.math", foreground: "B45309", fontStyle: "bold" },
      { token: "string.math", foreground: "92400E" },
      { token: "number", foreground: "0F766E" },
      { token: "operator", foreground: "64748B" },
      { token: "identifier", foreground: "334155" },
      { token: "string", foreground: "0F766E" },
    ],
    colors: {
      "editor.background": "#FBFCFD",
      "editor.foreground": "#15202B",
      "editor.lineHighlightBackground": "#F0F5F4",
      "editorCursor.foreground": "#0F766E",
      "editor.selectionBackground": "#0F766E33",
      "editorSuggestWidget.background": "#FFFFFF",
      "editorSuggestWidget.border": "#D7DEE7",
      "editorSuggestWidget.selectedBackground": "#D9F3EF",
      "editorSuggestWidget.highlightForeground": "#0F766E",
    },
  });

  monaco.editor.defineTheme(THEME_ID_DARK, {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: "7D8B99", fontStyle: "italic" },
      { token: "keyword", foreground: "2DD4BF", fontStyle: "bold" },
      { token: "keyword.environment", foreground: "60A5FA", fontStyle: "bold" },
      { token: "keyword.section", foreground: "FDBA74", fontStyle: "bold" },
      { token: "keyword.package", foreground: "C4B5FD" },
      { token: "keyword.reference", foreground: "FB923C" },
      { token: "keyword.formatting", foreground: "38BDF8" },
      { token: "keyword.math", foreground: "FBBF24" },
      { token: "keyword.escape", foreground: "2DD4BF" },
      { token: "delimiter.math", foreground: "FBBF24", fontStyle: "bold" },
      { token: "string.math", foreground: "FDE68A" },
      { token: "number", foreground: "2DD4BF" },
      { token: "operator", foreground: "94A3B8" },
      { token: "identifier", foreground: "E2E8F0" },
      { token: "string", foreground: "5EEAD4" },
    ],
    colors: {
      "editor.background": "#141B24",
      "editor.foreground": "#E8EEF4",
      "editor.lineHighlightBackground": "#1C2632",
      "editorCursor.foreground": "#2DD4BF",
      "editor.selectionBackground": "#2DD4BF44",
      "editorSuggestWidget.background": "#1A222C",
      "editorSuggestWidget.border": "#2A3542",
      "editorSuggestWidget.selectedBackground": "#1F3A36",
      "editorSuggestWidget.highlightForeground": "#2DD4BF",
    },
  });
}

export const LATEX_THEME = THEME_ID;
export const LATEX_THEME_DARK = THEME_ID_DARK;
export const LATEX_LANGUAGE = LANGUAGE_ID;
export const BIBTEX_LANGUAGE = BIB_ID;
