import { createInitialMcpStatus, type McpServerHealth } from "./status.js";
import { createSyntheticMcpTools, mapMcpToolToBuildrTool, type McpDiscoveredTool } from "./tools.js";
import type { McpConfigLoadResult } from "./config.js";
import type { McpPolicyOverlay } from "./policy.js";
import type { ToolDefinition } from "../types.js";

export interface McpRegistrySnapshot {
  servers: McpServerHealth[];
  tools: ToolDefinition[];
  warnings: string[];
}

export function createMcpRegistrySnapshot(
  config: McpConfigLoadResult,
  policyOverlay?: McpPolicyOverlay,
  discoveredTools: McpDiscoveredTool[] = createSyntheticMcpTools(config.servers)
): McpRegistrySnapshot {
  return {
    servers: config.servers.map(createInitialMcpStatus),
    tools: discoveredTools.map((tool) => mapMcpToolToBuildrTool(tool, policyOverlay)),
    warnings: config.warnings
  };
}
