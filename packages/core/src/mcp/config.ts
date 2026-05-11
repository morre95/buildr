import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type McpServerTransport = "stdio" | "streamable-http" | "sse";

export interface McpServerDefinition {
  name: string;
  type: McpServerTransport;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
}

export interface McpConfig {
  servers: Record<string, Omit<McpServerDefinition, "name">>;
}

export interface McpConfigLoadResult {
  path: string;
  servers: McpServerDefinition[];
  warnings: string[];
}

export async function loadWorkspaceMcpConfig(workspaceRoot: string): Promise<McpConfigLoadResult> {
  const path = join(workspaceRoot, ".vscode", "mcp.json");
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return { path, servers: [], warnings: ["No .vscode/mcp.json found."] };
  }

  return parseMcpConfig(raw, path);
}

export function parseMcpConfig(raw: string, path = ".vscode/mcp.json"): McpConfigLoadResult {
  const parsed = JSON.parse(raw) as McpConfig;
  const warnings: string[] = [];
  const servers: McpServerDefinition[] = [];

  for (const [name, definition] of Object.entries(parsed.servers ?? {})) {
    const type = normalizeTransport(definition.type);
    const server: McpServerDefinition = {
      name,
      type,
      ...(definition.command === undefined ? {} : { command: definition.command }),
      ...(definition.args === undefined ? {} : { args: definition.args }),
      ...(definition.url === undefined ? {} : { url: definition.url }),
      ...(definition.env === undefined ? {} : { env: definition.env })
    };
    warnings.push(...validateServerDefinition(server));
    servers.push(server);
  }

  return { path, servers, warnings };
}

function normalizeTransport(value: string): McpServerTransport {
  if (value === "http" || value === "streamable-http") {
    return "streamable-http";
  }
  if (value === "sse") {
    return "sse";
  }
  return "stdio";
}

function validateServerDefinition(server: McpServerDefinition): string[] {
  const warnings: string[] = [];
  if (server.type === "stdio" && server.command === undefined) {
    warnings.push(`MCP server "${server.name}" uses stdio but has no command.`);
  }
  if (server.type === "streamable-http" && server.url === undefined) {
    warnings.push(`MCP server "${server.name}" uses Streamable HTTP but has no url.`);
  }
  if (server.type === "sse") {
    warnings.push(`MCP server "${server.name}" uses legacy SSE; prefer Streamable HTTP.`);
  }
  if (server.env !== undefined && Object.keys(server.env).length > 0) {
    warnings.push(`MCP server "${server.name}" receives environment variables; review for secrets.`);
  }
  return warnings;
}
