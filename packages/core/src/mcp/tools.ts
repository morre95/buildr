import { decideMcpToolPermission, isLikelyWriteTool, type McpPolicyOverlay } from "./policy.js";
import type { McpServerDefinition } from "./config.js";
import type { PermissionLevel, ToolDefinition } from "../types.js";

export interface McpDiscoveredTool {
  serverName: string;
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export function mapMcpToolToBuildrTool(
  tool: McpDiscoveredTool,
  policyOverlay?: McpPolicyOverlay
): ToolDefinition {
  const isWriteTool = isLikelyWriteTool(tool.name);
  const decision = decideMcpToolPermission({
    toolName: tool.name,
    isWriteTool,
    ...(policyOverlay?.servers[tool.serverName] === undefined ? {} : { policy: policyOverlay.servers[tool.serverName] })
  });

  return {
    name: `mcp.${tool.serverName}.${tool.name}`,
    description: tool.description ?? `MCP tool ${tool.name} from ${tool.serverName}`,
    inputSchema: tool.inputSchema ?? { type: "object" },
    permission: permissionLevelFromDecision(decision)
  };
}

export function createSyntheticMcpTools(servers: McpServerDefinition[]): McpDiscoveredTool[] {
  return servers.map((server) => ({
    serverName: server.name,
    name: "list_tools",
    description: `List tools for MCP server ${server.name}`,
    inputSchema: { type: "object" }
  }));
}

function permissionLevelFromDecision(decision: "allow" | "ask" | "deny"): PermissionLevel {
  switch (decision) {
    case "allow":
      return "auto_allow";
    case "ask":
      return "require_approval";
    case "deny":
      return "always_deny";
  }
}
