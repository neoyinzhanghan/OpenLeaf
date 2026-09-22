import Editor, { type BeforeMount, type OnMount } from "@monaco-editor/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { editor as monacoEditor, type editor } from "monaco-editor";
import type { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";
import { bindYTextToMonaco, type YMonacoBinding } from "../collab/bindYTextToMonaco";
import {
  BIBTEX_LANGUAGE,
  LATEX_LANGUAGE,
  LATEX_THEME,
  LATEX_THEME_DARK,
  registerLatexLanguage,
  setLatexSuggestContext,
} from "../latex/register";
import { useTheme } from "../theme";
import { useMediaQuery } from "../hooks/useMediaQuery";

export type EditorJumpTarget = {
  /** When set, jump applies only after this file is open */
  path?: string;
  line: number;
  column: number;
  nonce?: number;
};

export type EditorSuggestionMark = {
  id: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
};

export type CommentMark = {
  line: number;
  color: string;
  resolved?: boolean;
  threadId?: string;
};

/** Integrity / claim-support gutter markers (same decoration mechanism as comments). */
export type CitationGutterMark = {
  line: number;
  citekey: string;
  /** supporting | contrasting | mentioning | unverifiable | not_checked | retracted | mismatch */
  kind: string;
};

export type CommentSelection = {
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  quote: string;
};

import type { DiffDeletedHunk } from "../api/types";

export type EditorChangeMarks = {
  addedLines: number[];
  deletedHunks: DiffDeletedHunk[];
  /** Entire open buffer is a deleted file (snapshot content, read-only view). */
  deletedFile?: boolean;
} | null;

type Props = {
  path: string | null;
  /** Controlled mode (binary/base64 or fallback). Ignored when yText is set. */
  value?: string;
  onChange?: (value: string) => void;
  onSave: () => void;
  jumpTo?: EditorJumpTarget | null;
  citations?: string[];
  citationHints?: import("../latex/completions").LatexCitationHint[];
  labels?: string[];
  /** Called when the user inserts a library citekey that is not yet in the project .bib. */
  onLibraryCite?: (citekey: string) => void;
  onForwardSearch?: (line: number, column: number) => void;
  /** Collaborative binding */
  yText?: Y.Text | null;
  awareness?: Awareness | null;
  /** Guest read-only mode: the server also drops any update, this just makes the UI honest. */
  readOnly?: boolean;
  /** Gutter markers for comment threads on this file */
  commentMarks?: CommentMark[];
  /** Citation integrity / claim gutter markers on this file */
  citationMarks?: CitationGutterMark[];
  /** Cmd/Ctrl+Alt+M or selection helper — open compose for current selection */
  onRequestComment?: (sel: CommentSelection) => void;
  /** Click a gutter mark → focus that thread in the comments panel */
  onOpenCommentThread?: (threadId: string) => void;
  /** Cursor-style show-changes decorations for the open file */
  changeMarks?: EditorChangeMarks;
  /** Grammarly-style AI suggestion underlines in the open buffer */
  suggestionMarks?: EditorSuggestionMark[];
  activeSuggestionId?: string | null;
  onSelectSuggestion?: (id: string) => void;
  suggestionPopup?: ReactNode;
  /** Pin the suggestion card to the bottom of the editor (phones). */
  suggestionDock?: boolean;
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

/** y-monaco indexes Y.Text as LF; Windows Monaco defaults to CRLF and drifts the caret. */
function forceModelLf(model: editor.ITextModel, monacoApi: typeof import("monaco-editor")): void {
  if (model.getEOL() !== "\n") {
    model.pushEOL(monacoApi.editor.EndOfLineSequence.LF);
  }
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

function positionInMark(
  pos: { lineNumber: number; column: number },
  m: EditorSuggestionMark,
): boolean {
  if (pos.lineNumber < m.startLine || pos.lineNumber > m.endLine) return false;
  if (m.startLine === m.endLine) {
    return pos.column >= m.startColumn && pos.column <= Math.max(m.endColumn, m.startColumn);
  }
  if (pos.lineNumber === m.startLine) return pos.column >= m.startColumn;
  if (pos.lineNumber === m.endLine) return pos.column <= m.endColumn;
  return true;
}

export function CodeEditor({
  path,
  value = "",
  onChange,
  onSave,
  jumpTo,
  citations = [],
  citationHints = [],
  labels = [],
  onLibraryCite,
  onForwardSearch,
  yText = null,
  awareness = null,
  readOnly = false,
  commentMarks = [],
  citationMarks = [],
  onRequestComment,
  onOpenCommentThread,
  changeMarks = null,
  suggestionMarks = [],
  activeSuggestionId = null,
  onSelectSuggestion,
  suggestionPopup = null,
  suggestionDock = false,
}: Props) {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof import("monaco-editor") | null>(null);
  const decoRef = useRef<string[]>([]);
  const commentDecoRef = useRef<string[]>([]);
  const citationDecoRef = useRef<string[]>([]);
  const changeDecoRef = useRef<string[]>([]);
  const suggestDecoRef = useRef<string[]>([]);
  const changeZoneIdsRef = useRef<string[]>([]);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const suggestionMarksRef = useRef(suggestionMarks);
  suggestionMarksRef.current = suggestionMarks;
  const selectSuggestionRef = useRef(onSelectSuggestion);
  selectSuggestionRef.current = onSelectSuggestion;
  const [popupPos, setPopupPos] = useState<{ top: number; left: number } | null>(null);
  const narrow = useMediaQuery("(max-width: 720px)");
  const decoTimerRef = useRef<number | null>(null);
  const forwardRef = useRef(onForwardSearch);
  forwardRef.current = onForwardSearch;
  const commentReqRef = useRef(onRequestComment);
  commentReqRef.current = onRequestComment;
  const openThreadRef = useRef(onOpenCommentThread);
  openThreadRef.current = onOpenCommentThread;
  const commentMarksRef = useRef(commentMarks);
  commentMarksRef.current = commentMarks;
  const saveRef = useRef(onSave);
  saveRef.current = onSave;
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const citationsRef = useRef(citations);
  const citationHintsRef = useRef(citationHints);
  const labelsRef = useRef(labels);
  const onLibraryCiteRef = useRef(onLibraryCite);
  citationsRef.current = citations;
  citationHintsRef.current = citationHints;
  labelsRef.current = labels;
  onLibraryCiteRef.current = onLibraryCite;
  const pathRef = useRef(path);
  pathRef.current = path;
  const bindingRef = useRef<YMonacoBinding | null>(null);
  /** Once a SyncTeX jump is applied, never re-apply it on typing */
  const appliedJumpKeyRef = useRef<string | null>(null);
  const collab = Boolean(yText);
  const [editorReady, setEditorReady] = useState(false);
  const { scheme } = useTheme();
  const monacoTheme = scheme === "dark" ? LATEX_THEME_DARK : LATEX_THEME;

  const beforeMount: BeforeMount = (monaco) => {
    monacoRef.current = monaco;
    registerLatexLanguage(monaco);
    setLatexSuggestContext(() => ({
      citations: citationsRef.current,
      citationHints: citationHintsRef.current,
      labels: labelsRef.current,
    }));
    // Every model (including ones @monaco-editor/react creates from `path`) must
    // stay on LF so Yjs offsets match, especially for Windows guests.
    monaco.editor.onDidCreateModel((model) => {
      forceModelLf(model, monaco);
    });
    monaco.editor.registerCommand("openleaf.syncLibraryCite", (_accessor, citekey: string) => {
      if (typeof citekey === "string" && citekey) onLibraryCiteRef.current?.(citekey);
    });
  };

  const centerOnLine = (ed: editor.IStandaloneCodeEditor, line: number, column: number) => {
    ed.layout();
    if (suggestionDock) ed.revealLineNearTop(line);
    else ed.revealLineInCenter(line);
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
      if (readOnlyRef.current) return;
      saveRef.current();
    });
    ed.addCommand(monacoApi.KeyMod.CtrlCmd | monacoApi.KeyMod.Alt | monacoApi.KeyCode.KeyJ, () => {
      const pos = ed.getPosition();
      if (pos && forwardRef.current) forwardRef.current(pos.lineNumber, pos.column);
    });
    ed.addCommand(monacoApi.KeyMod.CtrlCmd | monacoApi.KeyMod.Alt | monacoApi.KeyCode.KeyM, () => {
      const model = ed.getModel();
      const sel = ed.getSelection();
      const pos = ed.getPosition();
      if (!model || !commentReqRef.current) return;
      if (sel && !sel.isEmpty()) {
        const quote = model.getValueInRange(sel).trim().slice(0, 200);
        commentReqRef.current({
          line: sel.startLineNumber,
          column: sel.startColumn,
          endLine: sel.endLineNumber,
          endColumn: sel.endColumn,
          quote,
        });
        return;
      }
      if (!pos) return;
      const lineText = model.getLineContent(pos.lineNumber).trim().slice(0, 200);
      commentReqRef.current({
        line: pos.lineNumber,
        column: pos.column,
        endLine: pos.lineNumber,
        endColumn: pos.column,
        quote: lineText,
      });
    });

    ed.onMouseDown((e) => {
      // Gutter comment glyph → open that thread
      const t = e.target;
      const detail = t as { element?: Element | null; position?: { lineNumber: number; column?: number } | null };
      const el = detail.element;
      if (el?.classList?.contains("comment-line-glyph") || el?.closest?.(".comment-line-glyph")) {
        const line = detail.position?.lineNumber;
        if (line && openThreadRef.current) {
          const hit = commentMarksRef.current.find((m) => m.line === line && m.threadId);
          if (hit?.threadId) {
            e.event.preventDefault();
            e.event.stopPropagation();
            openThreadRef.current(hit.threadId);
            return;
          }
        }
      }
      const pos = e.target.position;
      if (pos && selectSuggestionRef.current) {
        const hit = suggestionMarksRef.current.find((m) => positionInMark(pos, m));
        if (hit) {
          selectSuggestionRef.current(hit.id);
        }
      }
      if (!e.event.ctrlKey && !e.event.metaKey) return;
      if (!e.target.position || !forwardRef.current) return;
      e.event.preventDefault();
      e.event.stopPropagation();
      forwardRef.current(e.target.position.lineNumber, e.target.position.column);
    });

    // Remeasure as soon as the editor exists — web fonts may still be swapping in.
    const remountFonts = () => {
      try {
        monacoApi.editor.remeasureFonts();
      } catch {
        /* older monaco */
      }
      ed.layout();
    };
    remountFonts();
    void (async () => {
      try {
        await document.fonts?.load?.('13px "JetBrains Mono"');
        await document.fonts?.ready;
      } catch {
        /* ignore */
      }
      remountFonts();
    })();
  };

  // Keep caret geometry honest for solo + collab: remount fonts whenever the
  // editor is live (not only when a Yjs binding mounts).
  useEffect(() => {
    if (!editorReady) return;
    const ed = editorRef.current;
    const monacoApi = monacoRef.current;
    if (!ed || !monacoApi) return;

    const remountFonts = () => {
      try {
        monacoApi.editor.remeasureFonts();
      } catch {
        /* older monaco */
      }
      ed.layout();
    };
    remountFonts();
    const fonts = document.fonts;
    const onResize = () => remountFonts();
    window.addEventListener("focus", remountFonts);
    window.addEventListener("resize", onResize);
    fonts?.addEventListener?.("loadingdone", remountFonts);
    const t1 = window.setTimeout(remountFonts, 100);
    const t2 = window.setTimeout(remountFonts, 500);
    return () => {
      window.removeEventListener("focus", remountFonts);
      window.removeEventListener("resize", onResize);
      fonts?.removeEventListener?.("loadingdone", remountFonts);
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [editorReady, path]);

  // Pane-title “Comment” button → same path as ⌘⌥M
  useEffect(() => {
    if (!editorReady) return;
    const onExternalComment = () => {
      const ed = editorRef.current;
      if (!ed || !commentReqRef.current) return;
      const model = ed.getModel();
      const sel = ed.getSelection();
      const pos = ed.getPosition();
      if (!model) return;
      if (sel && !sel.isEmpty()) {
        const quote = model.getValueInRange(sel).trim().slice(0, 200);
        commentReqRef.current({
          line: sel.startLineNumber,
          column: sel.startColumn,
          endLine: sel.endLineNumber,
          endColumn: sel.endColumn,
          quote,
        });
        return;
      }
      if (!pos) return;
      const lineText = model.getLineContent(pos.lineNumber).trim().slice(0, 200);
      commentReqRef.current({
        line: pos.lineNumber,
        column: pos.column,
        endLine: pos.lineNumber,
        endColumn: pos.column,
        quote: lineText,
      });
    };
    window.addEventListener("openleaf:request-comment", onExternalComment);
    return () => window.removeEventListener("openleaf:request-comment", onExternalComment);
  }, [editorReady]);

  // Comment gutter marks
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed || !editorReady) return;
    const marks = commentMarks.filter((m) => m.line >= 1);
    commentDecoRef.current = ed.deltaDecorations(
      commentDecoRef.current,
      marks.map((m) => ({
        range: {
          startLineNumber: m.line,
          startColumn: 1,
          endLineNumber: m.line,
          endColumn: 1,
        },
        options: {
          isWholeLine: false,
          linesDecorationsClassName: m.resolved
            ? "comment-line-glyph resolved"
            : "comment-line-glyph",
          overviewRuler: {
            color: m.resolved ? "#94A3B8" : m.color || "#0F766E",
            position: monacoEditor.OverviewRulerLane.Left,
          },
          minimap: {
            color: m.resolved ? "#94A3B8" : m.color || "#0F766E",
            position: monacoEditor.MinimapPosition.Inline,
          },
        },
      })),
    );
  }, [commentMarks, editorReady, path]);

  // Citation integrity / claim-support gutter marks (same mechanism as comments / highlight-since)
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed || !editorReady) return;
    const marks = citationMarks.filter((m) => m.line >= 1);
    citationDecoRef.current = ed.deltaDecorations(
      citationDecoRef.current,
      marks.map((m) => {
        const kind = m.kind;
        const color =
          kind === "retracted" || kind === "contrasting"
            ? "#B91C1C"
            : kind === "mismatch" || kind === "unverifiable"
              ? "#B45309"
              : kind === "supporting"
                ? "#0F766E"
                : "#64748B";
        return {
          range: {
            startLineNumber: m.line,
            startColumn: 1,
            endLineNumber: m.line,
            endColumn: 1,
          },
          options: {
            isWholeLine: false,
            linesDecorationsClassName: `citation-line-glyph citation-${kind}`,
            hoverMessage: {
              value: `Citation \`${m.citekey}\` · ${kind} _(triage — not certified)_`,
            },
            overviewRuler: {
              color,
              position: monacoEditor.OverviewRulerLane.Center,
            },
          },
        };
      }),
    );
  }, [citationMarks, editorReady, path]);

  // Cursor-style show-changes: green additions + red deleted view zones.
  // Re-apply on model swap (file/path remount) — decorations die with the old model.
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed || !editorReady) return;

    const clearMarks = () => {
      if (changeZoneIdsRef.current.length) {
        try {
          ed.changeViewZones((accessor) => {
            for (const zid of changeZoneIdsRef.current) accessor.removeZone(zid);
          });
        } catch {
          /* model already gone */
        }
        changeZoneIdsRef.current = [];
      }
      try {
        changeDecoRef.current = ed.deltaDecorations(changeDecoRef.current, []);
      } catch {
        changeDecoRef.current = [];
      }
    };

    const applyMarks = () => {
      const model = ed.getModel();
      clearMarks();
      if (!changeMarks || !model) return;

      const lineCount = model.getLineCount();

      if (changeMarks.deletedFile) {
        const all = Array.from({ length: lineCount }, (_, i) => i + 1);
        changeDecoRef.current = ed.deltaDecorations(
          changeDecoRef.current,
          all.map((line) => ({
            range: {
              startLineNumber: line,
              startColumn: 1,
              endLineNumber: line,
              endColumn: model.getLineMaxColumn(line),
            },
            options: {
              isWholeLine: true,
              className: "ol-diff-del-line",
              linesDecorationsClassName: "ol-diff-del-glyph",
              overviewRuler: {
                color: "#f85149",
                position: monacoEditor.OverviewRulerLane.Left,
              },
              minimap: {
                color: "#f85149",
                position: monacoEditor.MinimapPosition.Inline,
              },
            },
          })),
        );
        return;
      }

      const added = [...new Set(changeMarks.addedLines)].filter((n) => n >= 1 && n <= lineCount);
      changeDecoRef.current = ed.deltaDecorations(
        changeDecoRef.current,
        added.map((line) => ({
          range: {
            startLineNumber: line,
            startColumn: 1,
            endLineNumber: line,
            endColumn: model.getLineMaxColumn(line),
          },
          options: {
            isWholeLine: true,
            className: "ol-diff-add-line",
            linesDecorationsClassName: "ol-diff-add-glyph",
            overviewRuler: {
              color: "#3fb950",
              position: monacoEditor.OverviewRulerLane.Left,
            },
            minimap: {
              color: "#3fb950",
              position: monacoEditor.MinimapPosition.Inline,
            },
          },
        })),
      );

      const zoneIds: string[] = [];
      ed.changeViewZones((accessor) => {
        for (const hunk of changeMarks.deletedHunks) {
          if (!hunk.lines.length) continue;
          const after = Math.max(0, Math.min(lineCount, hunk.afterLine));
          const node = document.createElement("div");
          node.className = "ol-diff-del-zone";
          for (const text of hunk.lines) {
            const row = document.createElement("div");
            row.className = "ol-diff-del-row";
            const mark = document.createElement("span");
            mark.className = "ol-diff-del-sign";
            mark.textContent = "−";
            const body = document.createElement("span");
            body.className = "ol-diff-del-text";
            body.textContent = text.length ? text : " ";
            row.appendChild(mark);
            row.appendChild(body);
            node.appendChild(row);
          }
          const id = accessor.addZone({
            afterLineNumber: after,
            heightInPx: Math.max(18, hunk.lines.length * 20),
            domNode: node,
            suppressMouseDown: true,
          });
          zoneIds.push(id);
        }
      });
      changeZoneIdsRef.current = zoneIds;
    };

    applyMarks();
    // Model can remount after path/collab bind — re-paint once it lands.
    const subModel = ed.onDidChangeModel(() => {
      window.requestAnimationFrame(applyMarks);
    });
    const retry1 = window.setTimeout(applyMarks, 120);
    const retry2 = window.setTimeout(applyMarks, 400);

    return () => {
      subModel.dispose();
      window.clearTimeout(retry1);
      window.clearTimeout(retry2);
      clearMarks();
    };
  }, [changeMarks, editorReady, path]);

  // Grammarly-style underlines for pending AI suggestions
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed || !editorReady) return;
    const model = ed.getModel();
    if (!model) {
      suggestDecoRef.current = [];
      return;
    }
    suggestDecoRef.current = ed.deltaDecorations(
      suggestDecoRef.current,
      suggestionMarks.map((m) => {
        const startLine = Math.min(Math.max(1, m.startLine), model.getLineCount());
        const endLine = Math.min(Math.max(1, m.endLine), model.getLineCount());
        const startColumn = Math.max(1, m.startColumn);
        const endColumn = Math.max(startColumn, m.endColumn);
        return {
          range: {
            startLineNumber: startLine,
            startColumn,
            endLineNumber: endLine,
            endColumn: Math.min(endColumn, model.getLineMaxColumn(endLine)),
          },
          options: {
            inlineClassName:
              m.id === activeSuggestionId ? "ai-suggest-mark is-active" : "ai-suggest-mark",
            overviewRuler: {
              color: "#7C3AED",
              position: monacoEditor.OverviewRulerLane.Right,
            },
            minimap: {
              color: "#7C3AED",
              position: monacoEditor.MinimapPosition.Inline,
            },
            hoverMessage: { value: "AI suggestion — click to review" },
          },
        };
      }),
    );
    return () => {
      try {
        suggestDecoRef.current = ed.deltaDecorations(suggestDecoRef.current, []);
      } catch {
        suggestDecoRef.current = [];
      }
    };
  }, [suggestionMarks, activeSuggestionId, editorReady, path]);

  useEffect(() => {
    if (suggestionDock) {
      setPopupPos(suggestionPopup && activeSuggestionId ? { top: 0, left: 0 } : null);
      return;
    }
    const ed = editorRef.current;
    if (!ed || !editorReady || !activeSuggestionId || !suggestionPopup) {
      setPopupPos(null);
      return;
    }
    const mark = suggestionMarks.find((m) => m.id === activeSuggestionId);
    if (!mark) {
      setPopupPos(null);
      return;
    }

    const place = () => {
      const visible = ed.getScrolledVisiblePosition({
        lineNumber: mark.startLine,
        column: mark.startColumn,
      });
      const host = hostRef.current;
      if (!visible || !host) {
        setPopupPos(null);
        return;
      }
      const rect = host.getBoundingClientRect();
      const popW = Math.min(680, Math.max(280, rect.width - 16));
      const top = Math.min(Math.max(8, visible.top + visible.height + 6), Math.max(8, rect.height - 180));
      const left = Math.min(Math.max(8, visible.left), Math.max(8, rect.width - popW - 8));
      setPopupPos({ top, left });
    };

    place();
    const sub = ed.onDidScrollChange(place);
    const sub2 = ed.onDidLayoutChange(place);
    window.addEventListener("resize", place);
    return () => {
      sub.dispose();
      sub2.dispose();
      window.removeEventListener("resize", place);
    };
  }, [activeSuggestionId, suggestionMarks, suggestionPopup, editorReady, path, suggestionDock]);

  // Collaborative text: LF-safe binder (see bindYTextToMonaco). Stock y-monaco
  // leaves the local caret one character off for Windows guests.
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

    forceModelLf(model, monacoApi);
    const binding = bindYTextToMonaco(yText, model, new Set([ed]), awareness ?? undefined);
    bindingRef.current = binding;
    forceModelLf(model, monacoApi);

    // Web fonts (JetBrains Mono) load async. Until glyph metrics match what Monaco
    // measured at mount, the painted caret x-position drifts from the click target.
    const remountFonts = () => {
      try {
        monacoApi.editor.remeasureFonts();
      } catch {
        /* older monaco */
      }
      ed.layout();
    };
    remountFonts();
    const fonts = document.fonts;
    const waitFonts = async () => {
      try {
        await fonts?.load?.('400 13px "JetBrains Mono"');
        await fonts?.load?.('500 13px "JetBrains Mono"');
        await fonts?.ready;
      } catch {
        /* ignore */
      }
      remountFonts();
    };
    void waitFonts();
    const onResize = () => remountFonts();
    window.addEventListener("focus", remountFonts);
    window.addEventListener("resize", onResize);
    fonts?.addEventListener?.("loadingdone", remountFonts);

    return () => {
      window.removeEventListener("focus", remountFonts);
      window.removeEventListener("resize", onResize);
      fonts?.removeEventListener?.("loadingdone", remountFonts);
      binding.destroy();
      if (bindingRef.current === binding) bindingRef.current = null;
      queueMicrotask(() => {
        if (editorRef.current?.getModel() !== model) {
          model.dispose();
        }
      });
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
    <div className="monaco-host" ref={hostRef}>
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
          // Quote the family so metrics resolve to the same face CSS uses.
          fontFamily: '"JetBrains Mono", ui-monospace, Consolas, Menlo, Monaco, monospace',
          fontSize: narrow ? 16 : 13,
          lineHeight: narrow ? 24 : 20,
          letterSpacing: 0,
          cursorStyle: "line",
          cursorWidth: 2,
          cursorSmoothCaretAnimation: "off",
          // Web-font metrics often disagree with Monaco's monospace fast-path,
          // which paints the caret at the wrong x even when offsets are correct.
          disableMonospaceOptimizations: true,
          minimap: { enabled: false },
          wordWrap: "on",
          scrollBeyondLastLine: true,
          automaticLayout: true,
          padding: { top: 12, bottom: suggestionDock && suggestionPopup ? 220 : 48 },
          renderLineHighlight: "line",
          tabSize: 2,
          // Bracket match draws hollow boxes on `{` / `}` that look like a second
          // caret sitting next to yours — turn them off so only the real caret shows.
          matchBrackets: "never",
          bracketPairColorization: { enabled: false },
          guides: { bracketPairs: false, indentation: true },
          fontLigatures: false,
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
        }}
      />
      {suggestionPopup && popupPos && (
        <div
          className={`ai-gram-pop${suggestionDock ? " is-docked" : ""}`}
          style={suggestionDock ? undefined : { top: popupPos.top, left: popupPos.left }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {suggestionPopup}
        </div>
      )}
    </div>
  );
}
