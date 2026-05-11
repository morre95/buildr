import type { PermissionDecision, PermissionLevel, ToolDefinition } from "../types.js";

export interface PermissionRequest {
  tool: ToolDefinition;
  target?: string;
  command?: string;
}

export interface PermissionPolicy {
  decide(request: PermissionRequest): PermissionDecision;
}

export class DefaultPermissionPolicy implements PermissionPolicy {
  decide(request: PermissionRequest): PermissionDecision {
    if (isDangerousCommand(request.command)) {
      return "deny";
    }

    return decisionForLevel(request.tool.permission);
  }
}

export function decisionForLevel(level: PermissionLevel): PermissionDecision {
  switch (level) {
    case "auto_allow":
      return "allow";
    case "context_review":
    case "require_approval":
    case "always_confirm":
      return "ask";
    case "always_deny":
      return "deny";
  }
}

export function isDangerousCommand(command: string | undefined): boolean {
  if (command === undefined) {
    return false;
  }

  const normalized = command.toLowerCase();
  return [
    "rm -rf /",
    "chmod -r 777",
    "curl ",
    "wget ",
    ":(){",
    "mkfs",
    "dd if="
  ].some((pattern) => normalized.includes(pattern));
}
