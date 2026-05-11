import type { RankedContext } from "./ranking.js";

export interface CompressedContext {
  text: string;
  includedFiles: string[];
  omittedCount: number;
}

export function compressRankedContext(items: RankedContext[], maxChars = 4000): CompressedContext {
  const includedFiles: string[] = [];
  const chunks: string[] = [];
  let remaining = maxChars;

  for (const item of items) {
    const chunk = `${item.file.relativePath}\nscore=${item.score}; reasons=${item.reasons.join(", ")}\n${item.file.summary}\n`;
    if (chunk.length > remaining) {
      break;
    }
    chunks.push(chunk);
    includedFiles.push(item.file.relativePath);
    remaining -= chunk.length;
  }

  return {
    text: chunks.join("\n"),
    includedFiles,
    omittedCount: Math.max(0, items.length - includedFiles.length)
  };
}
