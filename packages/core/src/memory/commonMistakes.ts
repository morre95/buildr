import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface CommonMistake {
  id: string;
  pattern: string;
  avoidanceRule: string;
  severity: "low" | "medium" | "high";
  createdAt: string;
}

export async function readCommonMistakes(root: string): Promise<CommonMistake[]> {
  const path = join(root, ".buildr", "common-mistakes.jsonl");
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch {
    return [];
  }

  return content
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as CommonMistake);
}

export function matchCommonMistakes(mistakes: CommonMistake[], text: string): CommonMistake[] {
  const haystack = text.toLowerCase();
  return mistakes.filter((mistake) => {
    const patternTerms = mistake.pattern.toLowerCase().split(/\s+/u).filter((term) => term.length > 3);
    return patternTerms.some((term) => haystack.includes(term));
  });
}
