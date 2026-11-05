/**
 * Read-only block markers and `select block` resolution (#84).
 *
 * A `BlockStatement` has no stable symbol address, and reproducing a large body
 * just to name it is token-heavy. This module derives deterministic block IDs
 * from the current AST: every block is grouped by its nearest indexed
 * declaration and numbered in source preorder. `tsed --unify` renders those IDs
 * as view-only markers; `select block <symbol-id>:<node-id>` resolves the same
 * ID again at edit time. Nothing is persisted, so a marker can never go stale.
 */
import type { SelectionStage } from "./cascade";
import { positionAtOffset, sourceLineAt } from "./dsl-diagnostics";
import { findMatcherMatches, findRegexMatches } from "./matcher";
import { findLiteralMatches, pickMatchesSpan, resolvePickSpans } from "./module-boundary";
import type { Span } from "./module-boundary";
import { Parser } from "./parser";
import type { BlockStatement, Node, Program } from "./parser";
import { isBlockSelection } from "./selection";
import type { Selection } from "./selection";
import { buildIndex } from "./utility";
import type { IndexEntry } from "./utility";

/** The default inclusive line-span threshold for `--unify` markers. */
export const BLOCK_MARKER_MIN_LINES = 8;

/** The display symbol ID for a block that no index entry contains. */
export const MODULE_BLOCK_SYMBOL = "<module>";

const CANDIDATE_LIST_LIMIT = 8;

/** One block the current AST exposes, with its deterministic marker ID. */
export interface BlockInfo {
  /** `<symbol-id>:<node-id>`, the value accepted by `select block`. */
  id: string;
  symbolId: string;
  nodeId: number;
  /** Half-open brace span: `start` is at `{`, `end` is past `}`. */
  start: number;
  end: number;
  /** 1-based file-absolute line of the opening `{`. */
  startLine: number;
  /** 1-based file-absolute line of the closing `}`. */
  endLine: number;
}

interface BlockGroup {
  /** The nearest declaration node, or null for the module group. */
  node: Node | null;
  /** The display name before collision suffixes are applied. */
  name: string;
  display: string;
  blocks: BlockStatement[];
}

/** The stage a block clause failed at, in the edit-dsl failure vocabulary. */
export type BlockEditFailureStage = "address" | "matcher" | "range" | "no-op";

export type BlockSelectionResolution =
  | {
      ok: true;
      start: number;
      end: number;
      text: string;
      stage: SelectionStage;
      gateStart: number;
      block: BlockInfo;
    }
  | {
      ok: false;
      stage: BlockEditFailureStage;
      diagnostics: string;
    };

/**
 * Every `BlockStatement` in source preorder. The parser has no parent links, so
 * this walks own enumerable node fields once, skips scalar/source fields, and
 * dedupes shared nodes by object identity. Sorting by `start` makes the order
 * source order even when a node holds several child aliases.
 */
function collectBlockNodes(program: Program): BlockStatement[] {
  const blocks: BlockStatement[] = [];
  const seen = new Set<Node>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
      return;
    }
    if (typeof value !== "object" || value === null) {
      return;
    }
    const node = value as Partial<Node> & { kind?: string };
    if (typeof node.start !== "number" || typeof node.end !== "number") {
      return;
    }
    const typed = node as Node;
    if (seen.has(typed)) {
      return;
    }
    seen.add(typed);
    if (node.kind === "BlockStatement") {
      blocks.push(typed as BlockStatement);
    }
    for (const key of Object.keys(node)) {
      if (key === "start" || key === "end" || key === "source" || key === "raw") {
        continue;
      }
      visit((node as unknown as Record<string, unknown>)[key]);
    }
  };
  visit(program);
  blocks.sort((left, right) => left.start - right.start || right.end - left.end);
  return blocks;
}

function spanSize(node: Node): number {
  return node.end - node.start;
}

/**
 * The nearest declaration: the smallest indexed node that contains the block.
 * A tie on span prefers the declaration that starts later, which is the more
 * deeply nested owner. Entries sharing one node are the same group.
 */
function nearestEntry(entries: readonly IndexEntry[], block: BlockStatement): IndexEntry | null {
  let best: IndexEntry | null = null;
  for (const entry of entries) {
    if (entry.node.start > block.start || block.end > entry.node.end) {
      continue;
    }
    if (best === null) {
      best = entry;
      continue;
    }
    const size = spanSize(entry.node);
    const bestSize = spanSize(best.node);
    if (size < bestSize || (size === bestSize && entry.node.start > best.node.start)) {
      best = entry;
    }
  }
  return best;
}

/**
 * All source blocks with their stable `symbol-id:node-id` IDs. The ID set is
 * recomputed from the AST on every call; markers are never parsed back.
 */
export function collectBlockInfos(source: string, path: string): BlockInfo[] {
  const program = new Parser(source).parseProgram();
  const blocks = collectBlockNodes(program);
  if (blocks.length === 0) {
    return [];
  }
  const entries = buildIndex([{ path, source }]).entries;
  const groups = new Map<Node | null, BlockGroup>();
  const groupForBlock = new Map<BlockStatement, BlockGroup>();

  for (const block of blocks) {
    const entry = nearestEntry(entries, block);
    const node = entry === null ? null : entry.node;
    let group = groups.get(node);
    if (group === undefined) {
      const name = entry === null ? MODULE_BLOCK_SYMBOL : entry.locator.name;
      group = { node, name, display: name, blocks: [] };
      groups.set(node, group);
    }
    group.blocks.push(block);
    groupForBlock.set(block, group);
  }

  // Resolve display-name collisions the same way for unique and colliding
  // symbols: only a repeated display name gets `@<declaration start line>`.
  const byName = new Map<string, BlockGroup[]>();
  for (const group of groups.values()) {
    const list = byName.get(group.name);
    if (list === undefined) {
      byName.set(group.name, [group]);
    } else {
      list.push(group);
    }
  }
  for (const list of byName.values()) {
    if (list.length < 2) {
      continue;
    }
    const lineSuffixed = new Map<string, BlockGroup[]>();
    for (const group of list) {
      const line = group.node === null ? 1 : positionAtOffset(source, group.node.start).line;
      group.display = `${group.name}@${line}`;
      const key = group.display;
      const existing = lineSuffixed.get(key);
      if (existing === undefined) {
        lineSuffixed.set(key, [group]);
      } else {
        existing.push(group);
      }
    }
    // Two declarations of one name can start on the same line. Keep the ID
    // unique by falling back to the declaration column in that rare case.
    for (const [display, sameLine] of lineSuffixed) {
      if (sameLine.length < 2) {
        continue;
      }
      for (const group of sameLine) {
        const column = group.node === null ? 1 : positionAtOffset(source, group.node.start).column;
        group.display = `${display}:${column}`;
      }
    }
  }

  const counters = new Map<BlockGroup, number>();
  const infos: BlockInfo[] = [];
  for (const block of blocks) {
    const group = groupForBlock.get(block);
    if (group === undefined) {
      continue;
    }
    const nodeId = (counters.get(group) ?? 0) + 1;
    counters.set(group, nodeId);
    const startLine = positionAtOffset(source, block.start).line;
    const endLine = positionAtOffset(source, block.end - 1).line;
    infos.push({
      id: `${group.display}:${nodeId}`,
      symbolId: group.display,
      nodeId,
      start: block.start,
      end: block.end,
      startLine,
      endLine,
    });
  }
  return infos;
}

/** A numbered source line; `markers` are the IDs whose `{` opens on it. */
export interface UnifiedLine {
  line: number;
  text: string;
  markers: string[];
}

function sourceLines(source: string): { line: number; text: string }[] {
  if (source === "") {
    return [];
  }
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n" && index + 1 < source.length) {
      starts.push(index + 1);
    }
  }
  return starts.map((start, position) => {
    const newline = source.indexOf("\n", start);
    const end = newline === -1 ? source.length : newline;
    return { line: position + 1, text: source.slice(start, end).replace(/\r$/, "") };
  });
}

/**
 * The full numbered view. A qualifying block appends ` // <symbol>:<node>` to
 * the opening line; two blocks that open on one line append two markers in
 * preorder. The source line count is unchanged, and line numbers stay
 * file-absolute. `minLines` counts the inclusive `{` … `}` span.
 */
export function unifyLines(
  source: string,
  path: string,
  minLines = BLOCK_MARKER_MIN_LINES,
): UnifiedLine[] {
  const infos = collectBlockInfos(source, path);
  const markersByLine = new Map<number, string[]>();
  for (const block of infos) {
    if (block.endLine - block.startLine + 1 < minLines) {
      continue;
    }
    const markers = markersByLine.get(block.startLine);
    if (markers === undefined) {
      markersByLine.set(block.startLine, [block.id]);
    } else {
      markers.push(block.id);
    }
  }
  return sourceLines(source).map((line) => ({
    line: line.line,
    text: line.text,
    markers: markersByLine.get(line.line) ?? [],
  }));
}

/** Render the read-only `--unify` viewer, in the same numbered style as reads. */
export function renderUnifyView(
  source: string,
  path: string,
  minLines = BLOCK_MARKER_MIN_LINES,
): string {
  const lines = unifyLines(source, path, minLines);
  const marked = lines.reduce((total, line) => total + line.markers.length, 0);
  const counts = `${lines.length} line${lines.length === 1 ? "" : "s"}`;
  const header = `${path} (unified view, ${counts}${marked === 0 ? "" : `, ${marked} block marker${marked === 1 ? "" : "s"}`}):`;
  if (lines.length === 0) {
    return [header, "```text", "(empty file)", "```"].join("\n");
  }
  const width = String(lines.at(-1)?.line ?? 0).length;
  const rendered = lines.map((line) => {
    const suffix = line.markers.map((id) => ` // ${id}`).join("");
    return `${String(line.line).padStart(width)} | ${line.text}${suffix}`;
  });
  return [header, "```text", ...rendered, "```"].join("\n");
}

function blockFailure(stage: BlockEditFailureStage, diagnostics: string): BlockSelectionResolution {
  return { ok: false, stage, diagnostics };
}

function blockLabel(block: BlockInfo): string {
  return `block ${JSON.stringify(block.id)} (${block.startLine}-${block.endLine})`;
}

function unknownBlockDiagnostics(source: string, path: string, id: string): string {
  let available: string[] = [];
  try {
    available = collectBlockInfos(source, path).map((block) => block.id);
  } catch {
    // The caller already reported a parse failure; keep the hint simple.
  }
  const listed = available.slice(0, CANDIDATE_LIST_LIMIT);
  const more = available.length - listed.length;
  return [
    "stage: address",
    `cannot resolve ${JSON.stringify(id)} in ${JSON.stringify(path)}: no block with that ID exists in the current source`,
    ...(listed.length === 0
      ? []
      : [
          "available blocks:",
          ...listed.map((candidate) => `- ${candidate}`),
          ...(more > 0 ? [`- ... and ${more} more`] : []),
        ]),
    `run \`tsed --unify ${path}\` to see the current markers`,
  ].join("\n");
}

function candidateLine(path: string, source: string, span: Span): string {
  const { line, column } = positionAtOffset(source, span.start);
  return `- ${path}:${line}:${column}: ${sourceLineAt(source, span.start).text.trim()}`;
}

function ambiguousDiagnostics(
  path: string,
  source: string,
  block: BlockInfo,
  spans: readonly Span[],
  picked: boolean,
): string {
  const listed = spans.slice(0, CANDIDATE_LIST_LIMIT);
  const more = spans.length - listed.length;
  return [
    "stage: matcher",
    `the ${blockLabel(block)} ${picked ? "match + pick" : "match"} in ${JSON.stringify(path)} resolves to ${spans.length} spans; a block select must resolve exactly one span`,
    "candidates:",
    ...listed.map((span) => candidateLine(path, source, span)),
    ...(more > 0 ? [`- ... and ${more} more`] : []),
    "hint: extend the snippet, anchor or lengthen the regex, or add a `pick` range that contains exactly one candidate",
  ].join("\n");
}

function notFoundDiagnostics(
  path: string,
  block: BlockInfo,
  matcherKind: "snippet" | "regex",
): string {
  return [
    "stage: matcher",
    `the ${matcherKind === "regex" ? "`/regex/`" : "snippet"} matcher matched no span inside the ${blockLabel(block)} in ${JSON.stringify(path)}; a block select requires one unique span`,
    "copy the exact source text (or a complete statement/expression), use a regex anchored on that text, or use `pick` with file-absolute coordinates",
  ].join("\n");
}

function insideBlock(span: Span, block: BlockInfo): boolean {
  return block.start <= span.start && span.end <= block.end;
}

/**
 * Resolve one `select block <symbol-id>:<node-id> …` clause. The block's brace
 * span is the default target; `match` narrows structurally or by regex inside
 * it, and `pick` narrows by file-absolute coordinates. The two intersect when
 * both are present. An empty fence deletes exactly the resolved span.
 */
export function resolveBlockSelection(
  source: string,
  selection: Selection,
): BlockSelectionResolution {
  if (!isBlockSelection(selection)) {
    return blockFailure(
      "address",
      "stage: address\nthe block resolver received a non-block selection",
    );
  }
  if (selection.replacement === null) {
    return blockFailure(
      "address",
      [
        "stage: address",
        `a block select is an editor and requires \`replace with <fence>\``,
        `use \`tsed --unify ${selection.locator.path}\` to view the marked source`,
      ].join("\n"),
    );
  }
  let infos: BlockInfo[];
  try {
    infos = collectBlockInfos(source, selection.locator.path);
  } catch (error) {
    return blockFailure(
      "address",
      `stage: address\ncannot resolve a block select in ${JSON.stringify(selection.locator.path)}: the file does not parse (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  const matches = infos.filter((block) => block.id === selection.locator.name);
  if (matches.length === 0) {
    return blockFailure(
      "address",
      unknownBlockDiagnostics(source, selection.locator.path, selection.locator.name),
    );
  }
  if (matches.length > 1) {
    return blockFailure(
      "address",
      `stage: address\nthe block ID ${JSON.stringify(selection.locator.name)} is ambiguous in ${JSON.stringify(selection.locator.path)}; re-run \`tsed --unify ${selection.locator.path}\` and use the exact marker`,
    );
  }
  const block = matches[0];
  if (block === undefined) {
    return blockFailure(
      "address",
      `stage: address\ncannot resolve ${JSON.stringify(selection.locator.name)} in ${JSON.stringify(selection.locator.path)}`,
    );
  }

  let candidates: Span[] = [{ start: block.start, end: block.end }];
  let stage: SelectionStage = "whole-symbol";

  if (selection.matcher !== null) {
    if (selection.matcher.kind === "regex") {
      const found = findRegexMatches(
        source,
        { start: block.start, end: block.end },
        selection.matcher.value,
      );
      if (found.kind === "invalid") {
        return blockFailure(
          "matcher",
          `stage: matcher\nthe block \`/regex/\` matcher is invalid: ${found.message}; write a valid ECMA-262 pattern with no flags`,
        );
      }
      candidates = found.spans;
    } else {
      const found = findMatcherMatches(
        source,
        { start: block.start, end: block.end },
        selection.matcher.value,
      );
      if (found.kind === "unparseable") {
        candidates = findLiteralMatches(source, selection.matcher.value).filter((span) =>
          insideBlock(span, block),
        );
        if (candidates.length === 0) {
          return blockFailure(
            "matcher",
            [
              "stage: matcher",
              `the block snippet could not be parsed as TypeScript and was not found literally inside the ${blockLabel(block)} in ${JSON.stringify(selection.locator.path)}; a block select requires one unique span: ${found.message}`,
              "copy the exact source text, or use `/regex/` or `pick` with file-absolute coordinates",
            ].join("\n"),
          );
        }
      } else {
        candidates = found.spans;
      }
    }
    stage = "match";
  }

  if (selection.pick !== null) {
    const picks = resolvePickSpans(source, selection.pick, "block");
    if (!picks.ok) {
      return blockFailure("range", picks.diagnostics);
    }
    for (const pickSpan of picks.spans) {
      if (!insideBlock(pickSpan, block)) {
        return blockFailure(
          "range",
          [
            "stage: range",
            `the block \`pick\` range resolves outside the ${blockLabel(block)} in ${JSON.stringify(selection.locator.path)}`,
            `keep the pick inside lines ${block.startLine}-${block.endLine}, using the 1-based file-absolute coordinates from \`tsed --unify\``,
          ].join("\n"),
        );
      }
    }
    if (selection.matcher === null) {
      if (selection.pick.length !== 1) {
        return blockFailure(
          "range",
          [
            "stage: range",
            `a block select without \`match\` takes exactly one \`pick\` range; found ${selection.pick.length}`,
            "write one range, or add a `match` to filter several picked ranges",
          ].join("\n"),
        );
      }
      const only = picks.spans[0];
      candidates = only === undefined ? [] : [only];
    } else {
      candidates = candidates.filter((span) =>
        selection.pick!.some((range, index) => {
          const pickSpan = picks.spans[index];
          return pickSpan !== undefined && pickMatchesSpan(span, range, pickSpan);
        }),
      );
    }
    stage = "pick";
  }

  const seen = new Set<string>();
  candidates = candidates.filter((span) => {
    const key = `${span.start}:${span.end}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });

  if (candidates.length === 0) {
    if (selection.matcher !== null && selection.pick !== null) {
      return blockFailure(
        "matcher",
        [
          "stage: matcher",
          `the ${blockLabel(block)} match and pick in ${JSON.stringify(selection.locator.path)} intersect no candidate`,
          `widen the pick to include the match, or run \`tsed --unify ${selection.locator.path}\` to copy the current coordinates`,
        ].join("\n"),
      );
    }
    return blockFailure(
      "matcher",
      selection.matcher === null
        ? "stage: matcher\nthe block `pick` resolved no text span"
        : notFoundDiagnostics(selection.locator.path, block, selection.matcher.kind),
    );
  }
  if (candidates.length > 1) {
    return blockFailure(
      "matcher",
      ambiguousDiagnostics(
        selection.locator.path,
        source,
        block,
        candidates,
        selection.pick !== null,
      ),
    );
  }
  const target = candidates[0];
  if (target === undefined) {
    return blockFailure(
      "matcher",
      notFoundDiagnostics(selection.locator.path, block, selection.matcher?.kind ?? "snippet"),
    );
  }
  if (selection.replacement === source.slice(target.start, target.end)) {
    return blockFailure(
      "no-op",
      "stage: no-op\nthe block edit does not change the file: the replacement is identical to the text it replaces",
    );
  }
  return {
    ok: true,
    start: target.start,
    end: target.end,
    text: selection.replacement,
    stage,
    gateStart: target.start,
    block,
  };
}
