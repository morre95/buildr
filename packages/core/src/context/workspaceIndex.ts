import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { createWorkspaceFirewall } from "../security/contextFirewall.js";

export interface IndexedFile {
  path: string;
  relativePath: string;
  sizeBytes: number;
  symbols: string[];
  summary: string;
}

export interface WorkspaceIndex {
  root: string;
  files: IndexedFile[];
  generatedAt: string;
}

const SKIP_DIRS = new Set([".git", ".vscode", "node_modules", "dist", "out", "coverage", ".corepack", ".pnpm-store"]);
const TEXT_EXTENSIONS = new Set([
  ".c", ".cfg", ".cjs", ".clj", ".cpp", ".cs", ".css", ".dart", ".erl", ".ex",
  ".go", ".h", ".hpp", ".html", ".ini", ".java", ".js", ".json", ".jsx", ".jl",
  ".kt", ".lua", ".md", ".mjs", ".php", ".pl", ".py", ".r", ".rb", ".rs",
  ".scala", ".sh", ".sql", ".svelte", ".swift", ".toml", ".ts", ".tsx", ".txt",
  ".vue", ".xml", ".yaml", ".yml", ".zig"
]);

export async function buildWorkspaceIndex(root: string): Promise<WorkspaceIndex> {
  const firewall = await createWorkspaceFirewall(root);
  const files: IndexedFile[] = [];

  await walk(root, async (path) => {
    const pathDecision = firewall.inspectPath(path);
    if (!pathDecision.allowed || !TEXT_EXTENSIONS.has(extname(path))) {
      return;
    }

    const info = await stat(path);
    if (info.size > 250_000) {
      return;
    }

    const content = await readFile(path, "utf8");
    const textDecision = firewall.inspectText(content);
    files.push({
      path,
      relativePath: normalizePath(relative(root, path)),
      sizeBytes: info.size,
      symbols: extractSymbols(textDecision.redactedText ?? content),
      summary: summarizeFile(textDecision.redactedText ?? content)
    });
  });

  return {
    root,
    files,
    generatedAt: new Date().toISOString()
  };
}

async function walk(root: string, visit: (path: string) => Promise<void>): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) {
        await walk(join(root, entry.name), visit);
      }
    } else if (entry.isFile()) {
      await visit(join(root, entry.name));
    }
  }
}

function extractSymbols(content: string): string[] {
  const matches = content.matchAll(/\b(?:export\s+)?(?:class|function|interface|type|const|def|fn|func|pub\s+fn|fun|val|var|struct|enum|trait|impl|module|object)\s+([A-Za-z_$][\w$]*)/gu);
  return Array.from(matches, (match) => match[1]).filter((symbol): symbol is string => symbol !== undefined).slice(0, 50);
}

function summarizeFile(content: string): string {
  const firstLines = content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 3);
  return firstLines.join(" ").slice(0, 240);
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/");
}
