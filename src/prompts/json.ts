import type { Locator, SourceFile } from "../utility";
import {
  appendSpecSection,
  assembleSystemPrompt,
  numberedSourceBlock,
  RANGE_SELECTOR_NOTE,
} from "./shared";

const JSON_SELECT_SYSTEM_PARAGRAPH =
  'First you will be asked to select the target. Reply with ONLY a JSON object {"mode": "modify", "path": ..., "symbol": ..., "kind": ...}: "mode" is "modify" (default), "create", or "delete"; the composite address {path, symbol, kind} must all match the symbol index exactly and "kind" is required.';
const JSON_EDIT_SYSTEM_PARAGRAPH =
  'Then you will be asked to edit the selected symbol. Reply with ONLY one flat JSON object {"path": ..., "symbol": ..., "kind": ..., "matcher": ..., "replacement": ...}: the address {path, symbol, kind} must echo the pinned selection (a verification-repair round may re-pin to another declaration in the same file), and the optional "matcher" is a complete snippet copied from the current source that is structurally matched inside the symbol (omit it for a whole-symbol rewrite). As an alternative to "matcher", an optional "range" {line, column, endLine, endColumn} addresses the span by 1-based inclusive positions relative to the numbered current-source block shown in the prompt (the range must sit inside the declaration; when both are sent "range" wins). The replacement is a drop-in for the addressed range: keep leading keywords and modifiers consistent (do not re-add `export` the declaration omitted). Keep the same declaration kind and name unless the task requires otherwise. At most one matcher or range per response; multiple changes happen across edit rounds. No markdown fences and no explanations.';
const JSON_CREATE_DELETE_SYSTEM_PARAGRAPH =
  'A "create" selection asks for the COMPLETE declaration in "replacement"; the harness appends it to the target file, creating the file and any parent directories when needed. A "delete" selection carries no edit payload: the harness removes the declaration. To remove only part of a declaration, use "modify" with an empty "replacement". The syntax gate discards any edit that leaves the file unparseable and writes nothing.';
const JSON_ROUNDS_SYSTEM_PARAGRAPH =
  "There is no fixed exchange or round cap: the run continues while it makes progress and ends when an edit verifies, when the token budget is spent, or when the same reply/source/diagnostics repeats with no progress. When verification fails, the next attempt shows the current source and the failing diagnostics, and it may either revise the pinned declaration or re-pin to a different declaration in the same file by returning that declaration's own {path, symbol, kind} (the new address must resolve uniquely in the current source). A rejected or failing attempt is retried with its diagnostics and a correction; at a no-progress milestone the next attempt asks you to change the failing cause, or to reply `STOP` to end the run.";

export function buildJsonSystemPrompt(multiPayload = false): string {
  return assembleSystemPrompt(
    {
      select: JSON_SELECT_SYSTEM_PARAGRAPH,
      edit: JSON_EDIT_SYSTEM_PARAGRAPH,
      createDelete: JSON_CREATE_DELETE_SYSTEM_PARAGRAPH,
      rounds: JSON_ROUNDS_SYSTEM_PARAGRAPH,
    },
    multiPayload,
  );
}

export function buildUserPrompt(
  issue: string,
  contextYaml: string,
  specFiles: readonly SourceFile[] = [],
): string {
  const body = contextYaml === "" || contextYaml.endsWith("\n") ? contextYaml : `${contextYaml}\n`;
  const prompt = `# Issue\n\n${issue}\n\n# Project context\n\n\`\`\`yaml\n${body}\`\`\`\n`;
  return appendSpecSection(prompt, specFiles);
}

export function buildJsonEditPrompt(
  addressJson: string,
  symbolSource: string,
  multiPayload = false,
): string {
  const numbered = numberedSourceBlock(symbolSource);
  const instruction = multiPayload
    ? `Output ONE flat JSON object {"path": ..., "symbol": ..., "kind": ..., "matcher": ..., "replacement": ...} for the pinned symbol, or a multi-payload object {"payloads": [ ... ]} that batches edits — different files and/or several non-overlapping regions of one file — with no markdown fences and no explanations.

The first payload echoes the pinned address {path, symbol, kind}; every further payload names its own declaration, which must resolve to exactly one declaration in its file's current source. Same-file payloads must address non-overlapping regions. "matcher" is optional per payload: a complete snippet copied from the current source below; "replacement" replaces exactly the matched range. Omit "matcher" for a whole-symbol rewrite: "replacement" then replaces the whole declaration. ${RANGE_SELECTOR_NOTE} Keep leading keywords and modifiers consistent (do not re-add \`export\` the declaration omitted). Every replacement must keep its file parseable. The exchange applies atomically: if any payload fails its own guard or two same-file regions overlap, nothing is written and the exchange is rejected naming every failing payload.`
    : `Output ONE flat JSON object {"path": ..., "symbol": ..., "kind": ..., "matcher": ..., "replacement": ...} for the pinned symbol, with no markdown fences and no explanations.

Echo the pinned address {path, symbol, kind}. "matcher" is optional: a complete snippet copied from the current source below; "replacement" replaces exactly the matched range. Omit "matcher" for a whole-symbol rewrite: "replacement" then replaces the whole declaration. ${RANGE_SELECTOR_NOTE} Keep leading keywords and modifiers consistent (do not re-add \`export\` the declaration omitted). The replacement must keep the file parseable.`;
  return `${instruction}

Pinned selection:

\`\`\`json
${addressJson}
\`\`\`

Current source:

Each line below is prefixed with its 1-based line number (the optional "range" coordinates; columns count the source text after the \`N | \` prefix).

\`\`\`ts
${numbered}\n\`\`\`
`;
}

// Explicit-targets mode (#81): names the pending target addresses the model must
// cover with a batch, one flat payload per file. Same-file targets are named one
// at a time because they are sequenced across exchanges. The same lead is
// repeated on a retry so a non-batch reply cannot pass.
export function buildTargetsEditPrompt(
  pinnedAddressJson: string,
  symbolSource: string,
  pending: readonly Locator[],
): string {
  const numbered = numberedSourceBlock(symbolSource);
  const listed = pending
    .map(
      (target) =>
        `- {"path": ${JSON.stringify(target.path)}, "symbol": ${JSON.stringify(target.name)}, "kind": ${JSON.stringify(target.kind)}}`,
    )
    .join("\n");
  return `Output the edit(s) for the requested targets, with no markdown fences and no explanations. Reply with a {"payloads": [ ... ]} object carrying exactly one flat edit payload per file: the first payload echoes the pinned address below, and each further payload names one of the other requested addresses (a different file). A single target may still be sent as one flat object. Every payload's address must be one of the requested targets, and at most one target per file may appear in one exchange — same-file targets are addressed in successive exchanges.

Requested targets:
${listed}

"matcher" is optional per payload: a complete snippet copied from the current source; omit it for a whole-symbol rewrite. ${RANGE_SELECTOR_NOTE} Keep leading keywords and modifiers consistent (do not re-add \`export\` the declaration omitted). Every replacement must keep its file parseable.

Pinned selection:

\`\`\`json
${pinnedAddressJson}
\`\`\`

Current source:

Each line below is prefixed with its 1-based line number (the optional "range" coordinates; columns count the source text after the \`N | \` prefix).

\`\`\`ts
${numbered}\n\`\`\`
`;
}

export function buildJsonCreatePrompt(addressJson: string, path: string): string {
  const instruction = `The pinned selection uses mode "create". Output ONE flat JSON object {"path": ..., "symbol": ..., "kind": ..., "replacement": ...} with no markdown fences and no explanations: echo the pinned address {path, symbol, kind}, put the COMPLETE declaration in "replacement", and omit "matcher" and "range". The target file may not exist yet; the declaration is appended to it. The replacement must keep the file parseable.`;
  return `${instruction}

Target file:

\`\`\`
${path}
\`\`\`

Pinned selection:

\`\`\`json
${addressJson}
\`\`\`
`;
}

function selectionRetryBody(diagnostics: string): string {
  return `Output ONLY a corrected selection JSON object {"mode": ..., "path": ..., "symbol": ..., "kind": ...}, with no markdown fences and no prose.

Diagnostics:

\`\`\`
${diagnostics}
\`\`\`
`;
}

export function buildSelectionRetryPrompt(diagnostics: string): string {
  return `The previous selection was rejected. ${selectionRetryBody(diagnostics)}`;
}

/**
 * Selection-side no-progress ask (#52/#57): a repeated selection failure
 * milestone offers `STOP` or a corrected selection. It names a no-progress
 * cadence, never a fixed selection budget: a run that keeps making progress is
 * bounded by the token budget, not by this prompt. The prior-attempts digest
 * (#57) and failure history (#71) are appended after the diagnostics.
 */
export function buildSelectionContinuationPrompt(input: {
  failedAttempts: number;
  diagnostics: string;
  digest?: string;
  /** Failure history (#71), appended after the diagnostics before the digest. */
  failureHistory?: string;
}): string {
  const digestSection =
    input.digest === undefined || input.digest.trim() === "" ? "" : `\n${input.digest}\n`;
  const failureHistorySection =
    input.failureHistory === undefined || input.failureHistory.trim() === ""
      ? ""
      : `\n${input.failureHistory}\n`;
  return `No progress: ${input.failedAttempts} consecutive failed selection attempts; no fixed selection budget applies. Reply STOP to end the run, or return a corrected selection to continue.

${selectionRetryBody(input.diagnostics)}${failureHistorySection}${digestSection}`;
}
