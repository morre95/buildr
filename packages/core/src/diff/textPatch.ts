import { createHash } from "node:crypto";

export interface TextPatch {
  path: string;
  beforeHash: string;
  afterHash: string;
  before: string;
  after: string;
}

export function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function createTextPatch(path: string, before: string, after: string): TextPatch {
  return {
    path,
    before,
    after,
    beforeHash: hashText(before),
    afterHash: hashText(after)
  };
}

export function applyTextPatch(current: string, patch: TextPatch): string {
  const currentHash = hashText(current);
  if (currentHash !== patch.beforeHash) {
    throw new Error(`Patch conflict for ${patch.path}: file changed after proposal.`);
  }

  return patch.after;
}

export function formatTextPatchAsGitDiff(patch: TextPatch): string {
  const oldLines = splitPatchLines(patch.before);
  const newLines = splitPatchLines(patch.after);
  const diffLines = createLineDiff(oldLines, newLines);
  const hunk = createUnifiedHunk(diffLines, oldLines.length, newLines.length);
  return [
    `diff --git a/${patch.path} b/${patch.path}`,
    `index ${patch.beforeHash.slice(0, 7)}..${patch.afterHash.slice(0, 7)} 100644`,
    `--- a/${patch.path}`,
    `+++ b/${patch.path}`,
    hunk
  ].join("\n");
}

interface DiffLine {
  kind: "context" | "add" | "remove";
  text: string;
}

function splitPatchLines(value: string): string[] {
  if (value.length === 0) {
    return [];
  }
  const lines = value.split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function createLineDiff(oldLines: string[], newLines: string[]): DiffLine[] {
  const rows = oldLines.length + 1;
  const columns = newLines.length + 1;
  const table: number[][] = Array.from({ length: rows }, () => Array.from({ length: columns }, () => 0));

  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
      table[oldIndex]![newIndex] = oldLines[oldIndex] === newLines[newIndex]
        ? table[oldIndex + 1]![newIndex + 1]! + 1
        : Math.max(table[oldIndex + 1]![newIndex]!, table[oldIndex]![newIndex + 1]!);
    }
  }

  const result: DiffLine[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldLines.length && newIndex < newLines.length) {
    if (oldLines[oldIndex] === newLines[newIndex]) {
      result.push({ kind: "context", text: oldLines[oldIndex]! });
      oldIndex += 1;
      newIndex += 1;
    } else if (table[oldIndex + 1]![newIndex]! >= table[oldIndex]![newIndex + 1]!) {
      result.push({ kind: "remove", text: oldLines[oldIndex]! });
      oldIndex += 1;
    } else {
      result.push({ kind: "add", text: newLines[newIndex]! });
      newIndex += 1;
    }
  }

  while (oldIndex < oldLines.length) {
    result.push({ kind: "remove", text: oldLines[oldIndex]! });
    oldIndex += 1;
  }
  while (newIndex < newLines.length) {
    result.push({ kind: "add", text: newLines[newIndex]! });
    newIndex += 1;
  }
  return result;
}

function createUnifiedHunk(diffLines: DiffLine[], oldLineCount: number, newLineCount: number): string {
  const oldCount = oldLineCount === 0 ? 0 : oldLineCount;
  const newCount = newLineCount === 0 ? 0 : newLineCount;
  const body = diffLines.map((line) => {
    switch (line.kind) {
      case "add":
        return `+${line.text}`;
      case "remove":
        return `-${line.text}`;
      case "context":
        return ` ${line.text}`;
    }
  });
  return [
    `@@ -1,${oldCount} +1,${newCount} @@`,
    ...(body.length === 0 ? [""] : body)
  ].join("\n");
}
