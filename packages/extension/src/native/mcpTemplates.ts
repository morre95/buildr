import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import * as vscode from "vscode";

// Preset MCP servers offered when a workspace has no .vscode/mcp.json yet.
// Configurations follow the VS Code mcp.json schema (servers + optional inputs)
// and the official setup docs for each server. Secrets are never written to the
// file: GitHub uses a ${input:...} prompt that VS Code resolves at runtime.
interface McpServerTemplate {
  id: string;
  label: string;
  description: string;
  detail: string;
  server: Record<string, unknown>;
  inputs?: Record<string, unknown>[];
}

const MCP_SERVER_TEMPLATES: McpServerTemplate[] = [
  {
    id: "playwright",
    label: "Playwright",
    description: "Browser automation",
    detail: "Runs @playwright/mcp via npx. No credentials required.",
    server: {
      type: "stdio",
      command: "npx",
      args: ["-y", "@playwright/mcp@latest"]
    }
  },
  {
    id: "github",
    label: "GitHub",
    description: "Repositories, issues, and pull requests",
    detail: "Remote GitHub MCP server. VS Code prompts for a Personal Access Token.",
    server: {
      type: "http",
      url: "https://api.githubcopilot.com/mcp/",
      headers: { Authorization: "Bearer ${input:github_mcp_pat}" }
    },
    inputs: [
      {
        type: "promptString",
        id: "github_mcp_pat",
        description: "GitHub Personal Access Token",
        password: true
      }
    ]
  },
  {
    id: "figma",
    label: "Figma (Dev Mode MCP)",
    description: "Read designs and generate code from frames",
    detail: "Connects to the local server in the Figma desktop app (enable it under Preferences first).",
    server: {
      type: "http",
      url: "http://127.0.0.1:3845/mcp"
    }
  },
  {
    id: "docker",
    label: "Docker MCP Toolkit",
    description: "Containers, images, and the Docker MCP gateway",
    detail: "Runs the Docker Desktop MCP gateway. Requires Docker Desktop with the MCP Toolkit enabled.",
    server: {
      type: "stdio",
      command: "docker",
      args: ["mcp", "gateway", "run"]
    }
  }
];

// Offers to scaffold .vscode/mcp.json from the preset templates. Returns true
// when a file was written, so the caller can refresh its view.
export async function offerToCreateMcpConfig(mcpPath: string): Promise<boolean> {
  const choice = await vscode.window.showInformationMessage(
    "No .vscode/mcp.json found. Create one from a template?",
    "Choose servers",
    "Not now"
  );
  if (choice !== "Choose servers") {
    return false;
  }

  const picks = await vscode.window.showQuickPick(
    MCP_SERVER_TEMPLATES.map((template) => ({
      label: template.label,
      description: template.description,
      detail: template.detail,
      id: template.id
    })),
    {
      title: "Buildr: Create .vscode/mcp.json",
      placeHolder: "Select MCP servers to include.",
      canPickMany: true,
      ignoreFocusOut: true
    }
  );
  if (picks === undefined || picks.length === 0) {
    return false;
  }

  const selectedIds = new Set(picks.map((pick) => pick.id));
  const selected = MCP_SERVER_TEMPLATES.filter((template) => selectedIds.has(template.id));
  await mkdir(dirname(mcpPath), { recursive: true });
  await writeFile(mcpPath, renderMcpConfig(selected), "utf8");

  const document = await vscode.workspace.openTextDocument(mcpPath);
  await vscode.window.showTextDocument(document);
  vscode.window.showInformationMessage(
    `Created .vscode/mcp.json with ${selected.length} server(s). VS Code prompts for any required tokens when a server starts.`
  );
  return true;
}

function renderMcpConfig(templates: McpServerTemplate[]): string {
  const servers: Record<string, unknown> = {};
  const inputs: Record<string, unknown>[] = [];
  for (const template of templates) {
    servers[template.id] = template.server;
    if (template.inputs !== undefined) {
      inputs.push(...template.inputs);
    }
  }
  const config = inputs.length > 0 ? { inputs, servers } : { servers };
  return `${JSON.stringify(config, null, 2)}\n`;
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
