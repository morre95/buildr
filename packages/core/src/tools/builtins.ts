import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { applyTextPatch, createTextPatch, type TextPatch } from "../diff/textPatch.js";
import { ContextFirewall, createWorkspaceFirewall } from "../security/contextFirewall.js";
import type { ToolDefinition, ToolResult } from "../types.js";

export const builtInTools: ToolDefinition[] = [
  {
    name: "read_file",
    description: "Read allowed file content with context firewall checks.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    permission: "auto_allow"
  },
  {
    name: "search_codebase",
    description: "Search text files under an approved workspace root.",
    inputSchema: { type: "object", properties: { root: { type: "string" }, query: { type: "string" } }, required: ["root", "query"] },
    permission: "auto_allow"
  },
  {
    name: "propose_patch",
    description: "Create a text patch without applying it.",
    inputSchema: { type: "object" },
    permission: "auto_allow"
  },
  {
    name: "apply_patch",
    description: "Apply an approved text patch.",
    inputSchema: { type: "object" },
    permission: "require_approval"
  },
  {
    name: "run_terminal",
    description: "Run an approved terminal command.",
    inputSchema: { type: "object" },
    permission: "require_approval"
  },
  {
    name: "read_diagnostics",
    description: "Read VS Code Problems or supplied diagnostics.",
    inputSchema: { type: "object" },
    permission: "auto_allow"
  }
];

export async function readFileTool(path: string): Promise<ToolResult<{ content: string }>> {
  const content = await readFile(path, "utf8");
  const firewall = new ContextFirewall();
  const decision = firewall.inspectFileContext(path, content);
  if (!decision.allowed) {
    return {
      ok: false,
      summary: `Blocked reading ${path}.`,
      warnings: decision.warnings,
      provenance: [{ kind: "file", source: path }]
    };
  }

  return {
    ok: true,
    summary: `Read ${path}.`,
    data: { content: decision.redactedText ?? content },
    warnings: decision.warnings,
    provenance: [{ kind: "file", source: path }]
  };
}

export async function searchCodebaseTool(root: string, query: string): Promise<ToolResult<{ matches: string[] }>> {
  const matches: string[] = [];
  const firewall = await createWorkspaceFirewall(root);
  await walkTextFiles(root, async (path) => {
    const pathDecision = firewall.inspectPath(path);
    if (!pathDecision.allowed) {
      return;
    }
    const content = await readFile(path, "utf8");
    if (content.includes(query)) {
      matches.push(relative(root, path));
    }
  });

  return {
    ok: true,
    summary: `Found ${matches.length} file(s) containing "${query}".`,
    data: { matches },
    warnings: [],
    provenance: [{ kind: "generated", source: root }]
  };
}

export async function proposePatchTool(path: string, nextContent: string): Promise<ToolResult<TextPatch>> {
  const before = await readFile(path, "utf8");
  const patch = createTextPatch(path, before, nextContent);
  return {
    ok: true,
    summary: `Proposed patch for ${path}.`,
    data: patch,
    warnings: [],
    provenance: [{ kind: "file", source: path }]
  };
}

export async function applyPatchTool(patch: TextPatch): Promise<ToolResult<TextPatch>> {
  const current = await readFile(patch.path, "utf8");
  const next = applyTextPatch(current, patch);
  await writeFile(patch.path, next, "utf8");

  return {
    ok: true,
    summary: `Applied patch to ${patch.path}.`,
    data: patch,
    warnings: [],
    provenance: [{ kind: "file", source: patch.path }]
  };
}

const SKIP_DIRS = new Set(["node_modules", ".git", ".vscode", "dist", "out", "coverage", ".corepack", ".pnpm-store"]);

async function walkTextFiles(root: string, visit: (path: string) => Promise<void>): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) {
      continue;
    }

    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      await walkTextFiles(path, visit);
    } else if (isTextFile(entry.name)) {
      await visit(path);
    }
  }
}

function isTextFile(name: string): boolean {
  return /\.(c|cfg|cjs|clj|cpp|cs|css|dart|erl|ex|go|h|hpp|html|ini|java|js|json|jsx|jl|kt|lua|md|mjs|php|pl|py|r|rb|rs|scala|sh|sql|svelte|swift|toml|ts|tsx|txt|vue|xml|yaml|yml|zig)$/u.test(name);
}
