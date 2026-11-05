/**
 * Leading `export` modifier helpers for whole-declaration replacements.
 *
 * The symbol index points at the declaration node, which excludes a wrapping
 * `export`. A replacement may still carry the modifier, possibly after leading
 * whitespace or comments, so the harness normalizes only that leading modifier
 * instead of prefixing or stripping text blindly. Comments are trivia here:
 * a line comment or block comment may precede `export`, and both still count as
 * a leading export modifier.
 */

/** The offset after leading whitespace and comments. */
function leadingTriviaEnd(text: string): number {
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char !== undefined && /\s/.test(char)) {
      index += 1;
      continue;
    }
    if (text.startsWith("//", index)) {
      const newline = text.indexOf("\n", index + 2);
      index = newline === -1 ? text.length : newline + 1;
      continue;
    }
    if (text.startsWith("/*", index)) {
      const close = text.indexOf("*/", index + 2);
      index = close === -1 ? text.length : close + 2;
      continue;
    }
    break;
  }
  return index;
}

/** Locate a top-level leading `export` modifier after any whitespace/comments. */
export function leadingExportModifierSpan(
  text: string,
  includeDefault = true,
): { start: number; end: number } | null {
  const start = leadingTriviaEnd(text);
  const match = /^export\b/.exec(text.slice(start));
  if (match === null) {
    return null;
  }
  let end = start + match[0].length;
  if (includeDefault) {
    const defaultMatch = /^\s+default\b/.exec(text.slice(end));
    if (defaultMatch !== null) {
      end += defaultMatch[0].length;
    }
  }
  return { start, end };
}

/** True when the first non-trivia token is `export` (or `export default`). */
export function hasLeadingExportModifier(text: string): boolean {
  return leadingExportModifierSpan(text) !== null;
}

/**
 * Remove only the leading modifier, preserving any comments before it. By
 * default the whole `export default` pair is removed; `includeDefault: false`
 * removes just `export`, which keeps an intentional `default` conversion when
 * the source declaration's modifier is plain `export`.
 */
export function stripLeadingExportModifier(text: string, includeDefault = true): string {
  const span = leadingExportModifierSpan(text, includeDefault);
  if (span === null) {
    return text;
  }
  return `${text.slice(0, span.start)}${text.slice(span.end).replace(/^\s+/, "")}`;
}

/** Add `export` after any leading whitespace/comments; idempotent. */
export function addLeadingExportModifier(text: string): string {
  if (hasLeadingExportModifier(text)) {
    return text;
  }
  const index = leadingTriviaEnd(text);
  return `${text.slice(0, index)}export ${text.slice(index)}`;
}
