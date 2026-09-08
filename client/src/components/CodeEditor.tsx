import Editor, { type BeforeMount, type OnMount } from "@monaco-editor/react";
import { useEffect, useRef, useState } from "react";
import { editor as monacoEditor, type editor } from "monaco-editor";
import type { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";
import { MonacoBinding } from "y-monaco";
import {
  BIBTEX_LANGUAGE,
  LATEX_LANGUAGE,
  LATEX_THEME,
  LATEX_THEME_DARK,
  registerLatexLanguage,
  setLatexSuggestContext,
} from "../latex/register";
import { useTheme } from "../theme";

export type EditorJumpTarget = {
  /** When set, jump applies only after this file is open */
  path?: string;
  line: number;
  column: number;
  nonce?: number;
};

type Props = {
  path: string | null;
  /** Controlled mode (binary/base64 or fallback). Ignored when yText is set. */
  value?: string;
  onChange?: (value: string) => void;
  onSave: () => void;
  jumpTo?: EditorJumpTarget | null;
  citations?: string[];
  labels?: string[];
  onForwardSearch?: (line: number, column: number) => void;
  /** Collaborative binding */
  yText?: Y.Text | null;
  awareness?: Awareness | null;
  /** Guest read-only mode: the server also drops any update, this just makes the UI honest. */
  readOnly?: boolean;
};

function languageFor(path: string | null): string {
  if (!path) return "plaintext";
  const lower = path.toLowerCase();
  if (lower.endsWith(".tex") || lower.endsWith(".sty") || lower.endsWith(".cls") || lower.endsWith(".ltx")) {
    return LATEX_LANGUAGE;
  }
  if (lower.endsWith(".bib") || lower.endsWith(".bst") || lower.endsWith(".bbl")) return BIBTEX_LANGUAGE;
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".md")) return "markdown";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "html";
  if (lower.endsWith(".css")) return "css";
  if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) return "javascript";
  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "typescript";
  if (lower.endsWith(".xml")) return "xml";
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "yaml";
  if (lower.endsWith(".py")) return "python";
  if (lower.endsWith(".sh") || lower.endsWith(".bash")) return "shell";
  if (lower.endsWith(".r")) return "r";
  if (lower.endsWith(".sql")) return "sql";
  return "plaintext";
}

function pathMatches(openPath: string | null, target?: string): boolean {
  if (!target) return true;
  if (!openPath) return false;
  const a = openPath.replace(/\\/g, "/").replace(/^\.\//, "");
  const b = target.replace(/\\/g, "/").replace(/^\.\//, "");
  return a === b || a.endsWith("/" + b) || b.endsWith("/" + a);
}

function jumpKey(target: EditorJumpTarget): string {
  return `${target.nonce ?? 0}|${target.path ?? ""}|${target.line}|${target.column}`;
}

export function CodeEditor({
  path,
  value = "",
  onChange,
  onSave,
  jumpTo,
  citations = [],
  labels = [],
  onForwardSearch,
  yText = null,
  awareness = null,
  readOnly = false,
}: Props) {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof import("monaco-editor") | null>(null);
  const decoRef = useRef<string[]>([]);
  const decoTimerRef = useRef<number | null>(null);
  const forwardRef = useRef(onForwardSearch);
  forwardRef.current = onForwardSearch;
  const saveRef = useRef(onSave);
  saveRef.current = onSave;
  const citationsRef = useRef(citations);
  const labelsRef = useRef(labels);
  citationsRef.current = citations;
  labelsRef.current = labels;
  const pathRef = useRef(path);
  pathRef.current = path;
  const bindingRef = useRef<MonacoBinding | null>(null);
  /** Once a SyncTeX jump is applied, never re-apply it on typing */
  const appliedJumpKeyRef = useRef<string | null>(null);
  const collab = Boolean(yText);
  const [editorReady, setEditorReady] = useState(false);
  const { theme } = useTheme();
  const monacoTheme = theme === "dark" ? LATEX_THEME_DARK : LATEX_THEME;

  const beforeMount: BeforeMount = (monaco) => {
    monacoRef.current = monaco;
    registerLatexLanguage(monaco);
    setLatexSuggestContext(() => ({
      citations: citationsRef.current,
      labels: labelsRef.current,
    }));
  };

  const centerOnLine = (ed: editor.IStandaloneCodeEditor, line: number, column: number) => {
    ed.layout();
    ed.revealLineInCenter(line);
    ed.setPosition({ lineNumber: line, column });
    ed.focus();
  };

  const applyJump = (target: EditorJumpTarget): boolean => {
    const ed = editorRef.current;
    if (!ed) return false;
    const model = ed.getModel();
    if (!model) return false;
    const line = Math.min(Math.max(1, target.line), model.getLineCount());
    const maxCol = model.getLineMaxColumn(line);
    const column = Math.min(Math.max(1, target.column), maxCol);
    centerOnLine(ed, line, column);

    if (decoTimerRef.current) window.clearTimeout(decoTimerRef.current);
    decoRef.current = ed.deltaDecorations(decoRef.current, [
      {
        range: {
          startLineNumber: line,
          startColumn: 1,
          endLineNumber: line,
          endColumn: maxCol,
        },
        options: {
          isWholeLine: true,
          className: "sync-line-highlight",
          linesDecorationsClassName: "sync-line-glyph",
          overviewRuler: {
            color: "#0F766E",
            position: monacoEditor.OverviewRulerLane.Center,
          },
        },
      },
    ]);
    decoTimerRef.current = window.setTimeout(() => {
      if (editorRef.current) {
        decoRef.current = editorRef.current.deltaDecorations(decoRef.current, []);
      }
    }, 4000);

    return true;
  };

  const handleMount: OnMount = (ed, monacoApi) => {
    editorRef.current = ed;
    monacoRef.current = monacoApi;
    setEditorReady(true);
    ed.addCommand(monacoApi.KeyMod.CtrlCmd | monacoApi.KeyCode.KeyS, () => {
      saveRef.current();
    });
    ed.addCommand(monacoApi.KeyMod.CtrlCmd | monacoApi.KeyMod.Alt | monacoApi.KeyCode.KeyJ, () => {
      const pos = ed.getPosition();
      if (pos && forwardRef.current) forwardRef.current(pos.lineNumber, pos.column);
    });

    ed.onMouseDown((e) => {
      if (!e.event.ctrlKey && !e.event.metaKey) return;
      if (!e.target.position || !forwardRef.current) return;
      e.event.preventDefault();
      e.event.stopPropagation();
      forwardRef.current(e.target.position.lineNumber, e.target.position.column);
    });
  };

  // MonacoBinding for collaborative text.
  // Bind the *visible* @monaco-editor/react model (keyed by `path`) — a parallel
  // inmemory:// model left the UI on an empty cached buffer. Also force LF so
  // Monaco offsets match Y.Text indices (CRLF hosts/guests otherwise see the
  // caret sit one character behind; see y-monaco#6).
  useEffect(() => {
    bindingRef.current?.destroy();
    bindingRef.current = null;
    if (!editorReady) return;
    const ed = editorRef.current;
    const monacoApi = monacoRef.current;
    if (!ed || !yText || !path || !monacoApi) return;

    const model = ed.getModel();
    if (!model) return;
    const lang = languageFor(path);
    if (model.getLanguageId() !== lang) {
      monacoApi.editor.setModelLanguage(model, lang);
    }

    const yValue = yText.toString();
    model.pushEOL(monacoApi.editor.EndOfLineSequence.LF);
    if (model.getValue() !== yValue) {
      model.setValue(yValue);
      // setValue can restore the platform default EOL — pin LF again.
      model.pushEOL(monacoApi.editor.EndOfLineSequence.LF);
    }

    const binding = new MonacoBinding(yText, model, new Set([ed]), awareness ?? undefined);
    bindingRef.current = binding;

    return () => {
      binding.destroy();
      if (bindingRef.current === binding) bindingRef.current = null;
    };
  }, [yText, awareness, path, editorReady]);

  // Reset jump memo when the open file changes so SyncTeX can jump again
  useEffect(() => {
    appliedJumpKeyRef.current = null;
  }, [path]);

  useEffect(() => {
    if (!jumpTo) return;
    if (!pathMatches(path, jumpTo.path)) return;

    const key = jumpKey(jumpTo);
    if (appliedJumpKeyRef.current === key) return;

    let cancelled = false;
    // Collab file switches can take >1s (ensure + bind); keep trying.
    const attempts = [0, 40, 100, 200, 400, 800, 1600, 2800];
    const timers: number[] = [];

    const tryApply = () => {
      if (cancelled) return;
      if (appliedJumpKeyRef.current === key) return;
      const ed = editorRef.current;
      const model = ed?.getModel();
      if (!ed || !model || model.getLineCount() < 1) return;
      if (applyJump(jumpTo)) {
        appliedJumpKeyRef.current = key;
      }
    };

    for (const delay of attempts) {
      timers.push(window.setTimeout(tryApply, delay));
    }

    return () => {
      cancelled = true;
      for (const t of timers) window.clearTimeout(t);
    };
  }, [jumpTo, path, value, yText, editorReady]);

  // Keep Monaco theme in sync with app theme
  useEffect(() => {
    const monacoApi = monacoRef.current;
    if (!monacoApi || !editorReady) return;
    monacoApi.editor.setTheme(monacoTheme);
  }, [monacoTheme, editorReady]);

  if (!path) {
    return <div className="empty-hint">Select a file from the tree to edit.</div>;
  }

  return (
    <div className="monaco-host">
      <Editor
        path={path}
        // In collab mode MonacoBinding owns the model content — keep value undefined-ish
        value={collab ? undefined : value}
        defaultValue={collab ? yText?.toString() : undefined}
        language={languageFor(path)}
        onChange={collab ? undefined : (v) => onChange?.(v ?? "")}
        beforeMount={beforeMount}
        onMount={handleMount}
        theme={monacoTheme}
        options={{
          readOnly,
          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
          fontSize: 13,
          minimap: { enabled: false },
          wordWrap: "on",
          scrollBeyondLastLine: true,
          automaticLayout: true,
          padding: { top: 12, bottom: 48 },
          renderLineHighlight: "all",
          tabSize: 2,
          suggestOnTriggerCharacters: true,
          quickSuggestions: {
            other: true,
            comments: false,
            strings: true,
          },
          suggest: {
            showWords: false,
            snippetsPreventQuickSuggestions: false,
            insertMode: "replace",
          },
          acceptSuggestionOnCommitCharacter: true,
          acceptSuggestionOnEnter: "on",
          tabCompletion: "on",
          snippetSuggestions: "inline",
          autoClosingBrackets: "languageDefined",
          matchBrackets: "always",
        }}
      />
    </div>
  );
}
