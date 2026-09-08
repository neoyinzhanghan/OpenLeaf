/**
 * Monaco ↔ Y.Text binding that keeps the local caret aligned for Windows guests.
 *
 * Stock y-monaco is fine when Monaco's model is LF. On Windows, Monaco defaults
 * to CRLF and `setValue` reverts to that default — then `rangeOffset` (CRLF) no
 * longer matches Y.Text (LF) and the caret you see is not where keystrokes go.
 * We pin LF for the life of the binding and sync with LF-safe offsets.
 */
import * as monaco from "monaco-editor";
import { createMutex } from "lib0/mutex";
import * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";

function forceLf(model: monaco.editor.ITextModel): void {
  if (model.getEOL() !== "\n") {
    model.pushEOL(monaco.editor.EndOfLineSequence.LF);
  }
}

function normalizeText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "");
}

function yOffsetAt(model: monaco.editor.ITextModel, pos: monaco.IPosition): number {
  const line = Math.min(Math.max(1, pos.lineNumber), model.getLineCount());
  let offset = 0;
  for (let i = 1; i < line; i += 1) offset += model.getLineContent(i).length + 1;
  return offset + Math.min(Math.max(1, pos.column), model.getLineMaxColumn(line)) - 1;
}

export type YMonacoBinding = { destroy: () => void };

export function bindYTextToMonaco(
  yText: Y.Text,
  model: monaco.editor.ITextModel,
  editors: Set<monaco.editor.IStandaloneCodeEditor>,
  awareness?: Awareness | null,
): YMonacoBinding {
  const doc = yText.doc;
  if (!doc) throw new Error("Y.Text is not attached to a Y.Doc");

  const mux = createMutex();
  const disposables: { dispose: () => void }[] = [];
  const decorationIds = new Map<monaco.editor.IStandaloneCodeEditor, string[]>();

  const initial = normalizeText(yText.toString());
  if (initial !== yText.toString()) {
    doc.transact(() => {
      const cur = yText.toString();
      if (cur.length) yText.delete(0, cur.length);
      if (initial) yText.insert(0, initial);
    }, "eol-normalize");
  }
  forceLf(model);
  if (model.getValue() !== initial) model.setValue(initial);
  forceLf(model);

  const rerenderDecorations = () => {
    if (!awareness) return;
    editors.forEach((editor) => {
      if (editor.getModel() !== model) return;
      const prev = decorationIds.get(editor) ?? [];
      const next: monaco.editor.IModelDeltaDecoration[] = [];
      awareness.getStates().forEach((state, clientID) => {
        if (clientID === doc.clientID) return;
        const sel = state?.selection as
          | { anchor?: Y.RelativePosition; head?: Y.RelativePosition }
          | undefined;
        if (!sel?.anchor || !sel.head) return;
        const anchorAbs = Y.createAbsolutePositionFromRelativePosition(sel.anchor, doc);
        const headAbs = Y.createAbsolutePositionFromRelativePosition(sel.head, doc);
        if (!anchorAbs || !headAbs || anchorAbs.type !== yText || headAbs.type !== yText) return;
        const forward = anchorAbs.index <= headAbs.index;
        const start = model.getPositionAt(forward ? anchorAbs.index : headAbs.index);
        const end = model.getPositionAt(forward ? headAbs.index : anchorAbs.index);
        next.push({
          range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
          options: {
            className: `yRemoteSelection yRemoteSelection-${clientID}`,
            afterContentClassName: forward
              ? `yRemoteSelectionHead yRemoteSelectionHead-${clientID}`
              : undefined,
            beforeContentClassName: forward
              ? undefined
              : `yRemoteSelectionHead yRemoteSelectionHead-${clientID}`,
          },
        });
      });
      decorationIds.set(editor, editor.deltaDecorations(prev, next));
    });
  };

  const yObserver = (event: Y.YTextEvent) => {
    mux(() => {
      forceLf(model);
      const saved = new Map<monaco.editor.IStandaloneCodeEditor, { anchor: number; head: number }>();
      editors.forEach((editor) => {
        if (editor.getModel() !== model) return;
        const sel = editor.getSelection();
        if (!sel) return;
        saved.set(editor, {
          anchor: yOffsetAt(model, sel.getStartPosition()),
          head: yOffsetAt(model, sel.getEndPosition()),
        });
      });

      let index = 0;
      for (const op of event.delta) {
        if (op.retain !== undefined) index += op.retain;
        else if (op.insert !== undefined) {
          const insert = normalizeText(String(op.insert));
          const pos = model.getPositionAt(index);
          model.applyEdits([
            {
              range: new monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column),
              text: insert,
              forceMoveMarkers: true,
            },
          ]);
          index += insert.length;
        } else if (op.delete !== undefined) {
          const pos = model.getPositionAt(index);
          const endPos = model.getPositionAt(index + op.delete);
          model.applyEdits([
            {
              range: new monaco.Range(pos.lineNumber, pos.column, endPos.lineNumber, endPos.column),
              text: "",
              forceMoveMarkers: true,
            },
          ]);
        }
      }
      forceLf(model);
      const max = model.getValueLength();
      saved.forEach((rsel, editor) => {
        const a = model.getPositionAt(Math.max(0, Math.min(rsel.anchor, max)));
        const b = model.getPositionAt(Math.max(0, Math.min(rsel.head, max)));
        editor.setSelection(new monaco.Selection(a.lineNumber, a.column, b.lineNumber, b.column));
      });
      rerenderDecorations();
    });
  };
  yText.observe(yObserver);

  disposables.push(
    model.onDidChangeContent((event) => {
      mux(() => {
        // IMPORTANT: do not pushEOL before reading offsets — that rewrites the
        // model under the event and desyncs the local caret from keystrokes.
        const eol = model.getEOL();
        doc.transact(() => {
          const changes = [...event.changes].sort((a, b) => b.rangeOffset - a.rangeOffset);
          for (const change of changes) {
            const text = normalizeText(change.text);
            let startOff = change.rangeOffset;
            let deleteLen = change.rangeLength;
            if (eol !== "\n") {
              startOff = yOffsetAt(model, {
                lineNumber: change.range.startLineNumber,
                column: change.range.startColumn,
              });
              deleteLen = Math.max(
                0,
                change.rangeLength - (change.range.endLineNumber - change.range.startLineNumber),
              );
            }
            if (deleteLen > 0) yText.delete(startOff, deleteLen);
            if (text) yText.insert(startOff, text);
          }
        }, "monaco");
        forceLf(model);
      });
    }),
  );

  if (awareness) {
    editors.forEach((editor) => {
      disposables.push(
        editor.onDidChangeCursorSelection(() => {
          if (editor.getModel() !== model) return;
          const sel = editor.getSelection();
          if (!sel) return;
          let anchor = yOffsetAt(model, sel.getStartPosition());
          let head = yOffsetAt(model, sel.getEndPosition());
          if (sel.getDirection() === monaco.SelectionDirection.RTL) {
            const tmp = anchor;
            anchor = head;
            head = tmp;
          }
          awareness.setLocalStateField("selection", {
            anchor: Y.createRelativePositionFromTypeIndex(yText, anchor),
            head: Y.createRelativePositionFromTypeIndex(yText, head),
          });
        }),
      );
    });
    awareness.on("change", rerenderDecorations);
    rerenderDecorations();
  }

  let destroyed = false;
  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    yText.unobserve(yObserver);
    if (awareness) awareness.off("change", rerenderDecorations);
    for (const d of disposables) d.dispose();
    decorationIds.forEach((ids, editor) => editor.deltaDecorations(ids, []));
    decorationIds.clear();
  };
  disposables.push(model.onWillDispose(() => destroy()));

  return { destroy };
}
