import type { McpRegistrySnapshot } from "./registry.js";

export interface McpDoctorResult {
  ok: boolean;
  summary: string;
  warnings: string[];
}

export function runMcpDoctor(snapshot: McpRegistrySnapshot): McpDoctorResult {
  const warnings = [
    ...snapshot.warnings,
    ...snapshot.servers.filter((server) => server.status === "error").map((server) => server.message)
  ];

  return {
    ok: warnings.length === 0,
    summary: `${snapshot.servers.length} MCP server(s), ${snapshot.tools.length} mapped tool(s), ${warnings.length} warning(s).`,
    warnings
  };
}
