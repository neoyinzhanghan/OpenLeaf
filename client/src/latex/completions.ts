import type { languages, Position, editor, IRange } from "monaco-editor";
import { COMMANDS, ENVIRONMENTS } from "./catalog";

export type LatexCitationHint = {
  citekey: string;
  title?: string;
  detail?: string;
  /** When true, selecting this key should sync it into the project .bib. */
  fromLibrary?: boolean;
};

export type LatexSuggestContext = {
  citations: string[];
  /** Richer library + bib hints (preferred over bare citations when present). */
  citationHints?: LatexCitationHint[];
  labels: string[];
};

function wordRange(model: editor.ITextModel, position: Position): IRange {
  const word = model.getWordUntilPosition(position);
  return {
    startLineNumber: position.lineNumber,
    endLineNumber: position.lineNumber,
    startColumn: word.startColumn,
    endColumn: word.endColumn,
  };
}

/** Expand range leftward to include a leading backslash for command completion. */
function commandRange(model: editor.ITextModel, position: Position): IRange {
  const line = model.getLineContent(position.lineNumber);
  const before = line.slice(0, position.column - 1);
  const match = /\\[a-zA-Z@]*$/.exec(before);
  if (!match) return wordRange(model, position);
  const startColumn = position.column - match[0].length;
  return {
    startLineNumber: position.lineNumber,
    endLineNumber: position.lineNumber,
    startColumn,
    endColumn: position.column,
  };
}

const CITE_COMMANDS =
  "cite|citep|nocite|citet|citepauthor|citeyear|citeyearpar|parencite|autocite|textcite|footcite|fullcite|citeauthor";

function braceArgContext(model: editor.ITextModel, position: Position): {
  command: string;
  range: IRange;
} | null {
  const line = model.getLineContent(position.lineNumber);
  const before = line.slice(0, position.column - 1);
  const match = new RegExp(
    `\\\\(${CITE_COMMANDS}|ref|eqref|pageref|label|begin|end|includegraphics|input|include)\\{([^}]*)$`,
  ).exec(before);
  if (!match) return null;
  const arg = match[2] ?? "";
  return {
    command: match[1]!,
    range: {
      startLineNumber: position.lineNumber,
      endLineNumber: position.lineNumber,
      startColumn: position.column - arg.length,
      endColumn: position.column,
    },
  };
}

function isCiteCommand(command: string): boolean {
  return new RegExp(`^(?:${CITE_COMMANDS})$`).test(command);
}

export function createCompletionProvider(
  monaco: typeof import("monaco-editor"),
  getContext: () => LatexSuggestContext,
): languages.CompletionItemProvider {
  return {
    triggerCharacters: ["\\", "{", ",", "/"],
    provideCompletionItems(model, position) {
      const ctx = getContext();
      const suggestions: languages.CompletionItem[] = [];

      const arg = braceArgContext(model, position);
      if (arg) {
        if (isCiteCommand(arg.command)) {
          const seen = new Set<string>();
          for (const hint of ctx.citationHints ?? []) {
            if (seen.has(hint.citekey)) continue;
            seen.add(hint.citekey);
            suggestions.push({
              label: hint.citekey,
              kind: monaco.languages.CompletionItemKind.Reference,
              insertText: hint.citekey,
              detail: hint.detail ?? (hint.fromLibrary ? "library" : "citation"),
              documentation: hint.title,
              range: arg.range,
              ...(hint.fromLibrary
                ? {
                    command: {
                      id: "openleaf.syncLibraryCite",
                      title: "Sync library cite into project .bib",
                      arguments: [hint.citekey],
                    },
                  }
                : {}),
            });
          }
          for (const key of ctx.citations) {
            if (seen.has(key)) continue;
            seen.add(key);
            suggestions.push({
              label: key,
              kind: monaco.languages.CompletionItemKind.Reference,
              insertText: key,
              detail: "citation",
              range: arg.range,
            });
          }
          return { suggestions };
        }
        if (
          arg.command === "ref" ||
          arg.command === "eqref" ||
          arg.command === "pageref" ||
          arg.command === "label"
        ) {
          for (const key of ctx.labels) {
            suggestions.push({
              label: key,
              kind: monaco.languages.CompletionItemKind.Reference,
              insertText: key,
              detail: "label",
              range: arg.range,
            });
          }
          return { suggestions };
        }
        if (arg.command === "begin" || arg.command === "end") {
          for (const env of ENVIRONMENTS) {
            suggestions.push({
              label: env,
              kind: monaco.languages.CompletionItemKind.EnumMember,
              insertText: env,
              detail: "environment",
              range: arg.range,
            });
          }
          return { suggestions };
        }
      }

      const range = commandRange(model, position);
      const line = model.getLineContent(position.lineNumber);
      const before = line.slice(0, position.column - 1);
      const typingCommand = /\\[a-zA-Z@]*$/.test(before);

      if (typingCommand || before.endsWith("\\")) {
        for (const cmd of COMMANDS) {
          suggestions.push({
            label: cmd.label,
            kind: monaco.languages.CompletionItemKind.Function,
            insertText: cmd.insertText,
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            detail: cmd.detail,
            documentation: cmd.detail,
            range,
          });
        }

        for (const env of ENVIRONMENTS) {
          suggestions.push({
            label: `\\begin{${env}} … \\end{${env}}`,
            kind: monaco.languages.CompletionItemKind.Snippet,
            insertText: `\\begin{${env}}\n\t$0\n\\end{${env}}`,
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            detail: `environment ${env}`,
            sortText: `2${env}`,
            range,
          });
        }
      }

      return { suggestions };
    },
  };
}

export function extractCitations(bibText: string): string[] {
  const keys = new Set<string>();
  for (const m of bibText.matchAll(/@\w+\s*\{\s*([^,\s]+)\s*,/g)) {
    keys.add(m[1]);
  }
  return [...keys].sort();
}

export function extractLabels(texText: string): string[] {
  const keys = new Set<string>();
  for (const m of texText.matchAll(/\\label\{([^}]+)\}/g)) {
    keys.add(m[1]);
  }
  return [...keys].sort();
}
