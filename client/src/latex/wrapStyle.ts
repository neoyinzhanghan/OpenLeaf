export type LatexStyleCommand = "textit" | "textbf" | "underline" | "hl";

export type LatexStyleEdit = {
  /** Characters before the selection that the replacement also consumes. */
  before: number;
  /** Characters after the selection that the replacement also consumes. */
  after: number;
  text: string;
  /** Selection within `text`. Equal ends are a caret. */
  selStart: number;
  selEnd: number;
};

const WORD = "[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*";

const STYLE_BY_CODE: Record<string, { command: LatexStyleCommand; shift: boolean | "either" }> = {
  // Italic and bold accept the chord with or without Shift.
  KeyI: { command: "textit", shift: "either" },
  KeyB: { command: "textbf", shift: "either" },
  // Shift keeps these off the browser's history (Ctrl+H) and view-source (Ctrl+U).
  KeyU: { command: "underline", shift: true },
  KeyH: { command: "hl", shift: true },
};

/**
 * Ctrl/Cmd+I and Ctrl/Cmd+B, also with Shift.
 * Underline and highlight are Ctrl/Cmd+Shift+U and Ctrl/Cmd+Shift+H.
 * Physical `code` so the letter does not depend on the keyboard layout.
 */
export function latexStyleFromKeyboard(event: {
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat?: boolean;
  isComposing?: boolean;
}): LatexStyleCommand | null {
  if (event.repeat || event.isComposing) return null;
  if (event.altKey) return null;
  if (event.ctrlKey === event.metaKey) return null;
  const hit = STYLE_BY_CODE[event.code];
  if (!hit || (hit.shift !== "either" && hit.shift !== event.shiftKey)) return null;
  return hit.command;
}

/** Same length as `source`, with comments replaced by spaces so indexes still match. */
function maskComments(source: string): string {
  let out = "";
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "%" && !isEscaped(source, i)) {
      while (i < source.length && source[i] !== "\n") {
        out += " ";
        i += 1;
      }
      if (i < source.length && source[i] === "\n") out += "\n";
      continue;
    }
    out += source[i];
  }
  return out;
}

function lineStartAfter(source: string, index: number): number {
  const nl = source.indexOf("\n", index);
  return nl === -1 ? source.length : nl + 1;
}

/**
 * `\hl` comes from soul. Return a preamble insert when the document uses it
 * and neither loads soul nor defines the command itself.
 * Returns null for files with no preamble (`\begin{document}`).
 */
export function planHighlightPackage(source: string): { at: number; text: string } | null {
  const masked = maskComments(source);
  if (!/\\hl(?![A-Za-z])/.test(masked)) return null;
  if (/\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{[^}]*\bsoul(?:utf8)?\b/.test(masked)) return null;
  if (
    /\\(?:newcommand|renewcommand|providecommand|DeclareRobustCommand)\*?\s*\{\\hl\}/.test(masked) ||
    /\\(?:def|let)\\hl(?![A-Za-z])/.test(masked)
  ) {
    return null;
  }
  const begin = masked.search(/\\begin\s*\{document\}/);
  if (begin < 0) return null;
  const preamble = masked.slice(0, begin);
  const packages = [...preamble.matchAll(/\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{[^}]*\}/g)];
  const anchor = packages.length
    ? packages[packages.length - 1]
    : /\\documentclass\s*(?:\[[^\]]*\])?\s*\{[^}]*\}/.exec(preamble);
  if (!anchor || anchor.index == null) return { at: begin, text: "\\usepackage{soul}\n" };
  return { at: lineStartAfter(source, anchor.index), text: "\\usepackage{soul}\n" };
}

function isEscaped(text: string, index: number): boolean {
  let slashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) slashes += 1;
  return slashes % 2 === 1;
}

function bracesBalanced(text: string): boolean {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (isEscaped(text, i)) continue;
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}") {
      depth -= 1;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

/** The selection is exactly `\command{...}` with a balanced body. */
function unwrapWhole(selected: string, command: LatexStyleCommand): string | null {
  const open = `\\${command}{`;
  if (!selected.startsWith(open) || !selected.endsWith("}")) return null;
  const inner = selected.slice(open.length, -1);
  if (!bracesBalanced(inner)) return null;
  return inner;
}

function findEnclosing(
  before: string,
  selected: string,
  after: string,
  command: LatexStyleCommand,
): {
  dropBefore: number;
  dropAfter: number;
  inner: string;
  caretInInner: number;
  selectionIsEntireInterior: boolean;
} | null {
  let depth = 0;
  for (let i = before.length - 1; i >= 0; i--) {
    const ch = before[i];
    if (ch === "}" && !isEscaped(before, i)) {
      depth += 1;
      continue;
    }
    if (ch !== "{" || isEscaped(before, i)) continue;
    if (depth > 0) {
      depth -= 1;
      continue;
    }
    const lead = `\\${command}`;
    // A nearer group may belong to another command. Keep walking outward so
    // `\textbf{\textit{x|}}` still unwraps `\textbf` on Ctrl+B.
    if (i < lead.length || before.slice(i - lead.length, i) !== lead) continue;
    const openAbs = i;
    const cmdStart = i - lead.length;
    const full = before + selected + after;
    let nest = 1;
    let closeAbs = -1;
    for (let k = openAbs + 1; k < full.length; k++) {
      if (isEscaped(full, k)) continue;
      if (full[k] === "{") nest += 1;
      else if (full[k] === "}") {
        nest -= 1;
        if (nest === 0) {
          closeAbs = k;
          break;
        }
      }
    }
    if (closeAbs < 0) continue;
    const innerStart = openAbs + 1;
    const inner = full.slice(innerStart, closeAbs);
    const selStartAbs = before.length;
    const selEndAbs = before.length + selected.length;
    if (selStartAbs < innerStart || selEndAbs > closeAbs) continue;
    return {
      dropBefore: before.length - cmdStart,
      dropAfter: closeAbs - selEndAbs + 1,
      inner,
      caretInInner: selStartAbs - innerStart,
      selectionIsEntireInterior: selStartAbs === innerStart && selEndAbs === closeAbs,
    };
  }
  return null;
}

function findWord(before: string, after: string): { before: number; after: number; token: string } | null {
  const leftMatch = new RegExp(`(?:\\\\[A-Za-z]*|${WORD})$`).exec(before);
  const left = leftMatch?.[0] ?? "";
  if (left.startsWith("\\")) {
    const more = /^[A-Za-z]*/.exec(after)?.[0] ?? "";
    const token = left + more;
    if (token === "\\") return null;
    return { before: left.length, after: more.length, token };
  }
  if (!left) {
    const commandAhead = /^\\[A-Za-z]+/.exec(after)?.[0];
    if (commandAhead) return { before: 0, after: commandAhead.length, token: commandAhead };
  }
  const right = new RegExp(`^(?:${WORD})`).exec(after)?.[0] ?? "";
  // `label| -free` is not one word; `label|-free` is.
  // Use a ternary: `left &&` would yield "" and "" ?? right stays "".
  const hyphenTail = left ? new RegExp(`^-(?:${WORD})`).exec(after)?.[0] : undefined;
  const token = left + (hyphenTail ?? right);
  if (!token) return null;
  return { before: left.length, after: (hyphenTail ?? right).length, token };
}

/**
 * Wrap the selection in `\textit`, `\textbf`, `\underline`, or `\hl`.
 * The same shortcut on text already wrapped in that command removes it.
 * With no selection, the word or command under the caret is wrapped, or an
 * empty command is inserted and the caret is placed inside the braces.
 */
export function planLatexStyle(
  before: string,
  selected: string,
  after: string,
  command: LatexStyleCommand,
): LatexStyleEdit {
  const whole = unwrapWhole(selected, command);
  if (whole != null) {
    return { before: 0, after: 0, text: whole, selStart: 0, selEnd: whole.length };
  }

  const enclosing = findEnclosing(before, selected, after, command);
  if (enclosing && (selected.length === 0 || enclosing.selectionIsEntireInterior)) {
    if (selected.length === 0) {
      const caret = Math.max(0, Math.min(enclosing.caretInInner, enclosing.inner.length));
      return {
        before: enclosing.dropBefore,
        after: enclosing.dropAfter,
        text: enclosing.inner,
        selStart: caret,
        selEnd: caret,
      };
    }
    return {
      before: enclosing.dropBefore,
      after: enclosing.dropAfter,
      text: enclosing.inner,
      selStart: 0,
      selEnd: enclosing.inner.length,
    };
  }

  if (selected.length > 0) {
    const text = `\\${command}{${selected}}`;
    const origin = command.length + 2;
    return { before: 0, after: 0, text, selStart: origin, selEnd: origin + selected.length };
  }

  const word = findWord(before, after);
  if (word) {
    const text = `\\${command}{${word.token}}`;
    const origin = command.length + 2;
    return {
      before: word.before,
      after: word.after,
      text,
      selStart: origin,
      selEnd: origin + word.token.length,
    };
  }

  const text = `\\${command}{}`;
  const caret = command.length + 2;
  return { before: 0, after: 0, text, selStart: caret, selEnd: caret };
}
