import { format } from "oxfmt";
import { buildIndex } from "./utility";
import type { Locator } from "./utility";

export interface Edit {
  locator: Locator;
  llmOutput: string;
}

interface Replacement {
  start: number;
  end: number;
  text: string;
  name: string;
}

export async function formatSource(fileName: string, source: string): Promise<string> {
  const { code, errors } = await format(fileName, source, {});
  const firstError = errors[0];
  if (firstError !== undefined) {
    throw new Error(`oxfmt failed: ${firstError.message}`);
  }
  return code;
}

/** True when the formatter rejected a replacement that duplicated `export`. */
function isDuplicateExportError(message: string): boolean {
  return /export/i.test(message) && /(?:modifier already seen|duplicate)/i.test(message);
}

/**
 * An actionable `stage: format` diagnostic: name the file and, when the
 * formatter rejected a duplicated modifier, point at the likely repair instead
 * of returning the bare oxfmt message.
 */
export function formatFailureDiagnostics(path: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const lines = ["stage: format", `${path}: ${message}`];
  if (isDuplicateExportError(message)) {
    lines.push(
      `hint: the edit produced a duplicate export modifier; remove the extra export from the replacement or use write ${path} with <<<TC_EDIT_BEGIN>>> … <<<TC_EDIT_END>>>.`,
    );
  }
  return lines.join("\n");
}

export async function applyEdits(
  source: string,
  edits: Edit[],
  fileName = "file.ts",
): Promise<string> {
  if (edits.length === 0) {
    return source;
  }

  const index = buildIndex([{ path: fileName, source }]);
  const replacements: Replacement[] = [];

  for (const edit of edits) {
    const matches = index.lookup({
      path: edit.locator.path,
      name: edit.locator.name,
      kind: edit.locator.kind,
    });
    const target = matches[0];
    if (target === undefined) {
      throw new Error(`no symbol ${edit.locator.kind} ${edit.locator.name} in ${fileName}`);
    }
    if (matches.length > 1) {
      throw new Error(
        `symbol ${edit.locator.kind} ${edit.locator.name} in ${fileName} resolves to ${matches.length} declarations; the harness never picks one silently`,
      );
    }
    replacements.push({
      start: target.node.start,
      end: target.node.end,
      text: edit.llmOutput,
      name: edit.locator.name,
    });
  }

  replacements.sort((left, right) => left.start - right.start);
  for (let i = 1; i < replacements.length; i += 1) {
    const previous = replacements[i - 1];
    const current = replacements[i];
    if (previous !== undefined && current !== undefined && current.start < previous.end) {
      throw new Error(`overlapping edits for ${previous.name} and ${current.name} in ${fileName}`);
    }
  }

  let updated = source;
  for (let i = replacements.length - 1; i >= 0; i -= 1) {
    const replacement = replacements[i];
    if (replacement === undefined) {
      continue;
    }
    updated =
      updated.slice(0, replacement.start) + replacement.text + updated.slice(replacement.end);
  }

  return formatSource(fileName, updated);
}
