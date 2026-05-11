import type { WorkspaceIndex } from "./workspaceIndex.js";

export interface ContextGraphEdge {
  from: string;
  to: string;
  reason: "imports" | "mentions-symbol";
}

export interface ContextGraph {
  nodes: string[];
  edges: ContextGraphEdge[];
}

export function buildContextGraph(index: WorkspaceIndex): ContextGraph {
  const nodes = index.files.map((file) => file.relativePath);
  const edges: ContextGraphEdge[] = [];

  for (const source of index.files) {
    for (const target of index.files) {
      if (source.relativePath === target.relativePath) {
        continue;
      }
      if (source.summary.includes(target.relativePath) || source.summary.includes(stripExtension(target.relativePath))) {
        edges.push({ from: source.relativePath, to: target.relativePath, reason: "imports" });
      } else if (target.symbols.some((symbol) => symbol.length > 3 && source.summary.includes(symbol))) {
        edges.push({ from: source.relativePath, to: target.relativePath, reason: "mentions-symbol" });
      }
    }
  }

  return { nodes, edges };
}

function stripExtension(path: string): string {
  return path.replace(/\.[^.]+$/u, "");
}
