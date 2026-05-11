import type { PermissionDecision } from "../types.js";

export interface McpServerPolicy {
  allowedRoots?: string[];
  denyPaths?: string[];
  readTools?: PermissionDecision;
  writeTools?: PermissionDecision;
  writeToolsRequireApproval?: boolean;
}

export interface McpPolicyOverlay {
  servers: Record<string, McpServerPolicy>;
}

export function parseMcpPolicyOverlay(raw: string): McpPolicyOverlay {
  return JSON.parse(raw) as McpPolicyOverlay;
}

export function decideMcpToolPermission(options: {
  policy?: McpServerPolicy;
  toolName: string;
  isWriteTool: boolean;
}): PermissionDecision {
  if (options.isWriteTool) {
    if (options.policy?.writeToolsRequireApproval === true) {
      return "ask";
    }
    return options.policy?.writeTools ?? "ask";
  }

  return options.policy?.readTools ?? "allow";
}

export function isLikelyWriteTool(toolName: string): boolean {
  return /(^|[_\-.])(write|create|update|delete|remove|patch|mutate|insert|drop)([_\-.]|$)/iu.test(toolName);
}
