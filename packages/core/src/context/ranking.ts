import type { IndexedFile, WorkspaceIndex } from "./workspaceIndex.js";

export interface RankedContext {
  file: IndexedFile;
  score: number;
  reasons: string[];
}

export function rankWorkspaceContext(index: WorkspaceIndex, query: string, limit = 10): RankedContext[] {
  const terms = tokenize(query);
  return index.files
    .map((file) => scoreFile(file, terms))
    .filter((ranked) => ranked.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function scoreFile(file: IndexedFile, terms: string[]): RankedContext {
  let score = 0;
  const reasons: string[] = [];
  const path = file.relativePath.toLowerCase();
  const summary = file.summary.toLowerCase();
  const symbols = file.symbols.map((symbol) => symbol.toLowerCase());

  for (const term of terms) {
    if (path.includes(term)) {
      score += 5;
      reasons.push(`path:${term}`);
    }
    if (symbols.some((symbol) => symbol.includes(term))) {
      score += 4;
      reasons.push(`symbol:${term}`);
    }
    if (summary.includes(term)) {
      score += 2;
      reasons.push(`summary:${term}`);
    }
  }

  if (file.relativePath.includes("test") || file.relativePath.includes("spec")) {
    score += 1;
    reasons.push("test-file");
  }

  return { file, score, reasons };
}

function tokenize(query: string): string[] {
  return Array.from(new Set(query.toLowerCase().split(/[^a-z0-9_$]+/u).filter((term) => term.length > 2)));
}
