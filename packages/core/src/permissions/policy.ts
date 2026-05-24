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
  return DANGEROUS_COMMAND_PATTERNS.some((pattern) => pattern.test(normalized));
}

const DANGEROUS_COMMAND_PATTERNS = [
  /\brm\s+-[^\n;|&]*r[^\n;|&]*f[^\n;|&]*(?:\s+\/|\s+\*|\s+~|\s+\$home|\s+\.)/u,
  /\bsudo\s+rm\s+-[^\n;|&]*r[^\n;|&]*f/u,
  /\bgit\s+clean\s+-[^\n;|&]*(?:x[^\n;|&]*f|f[^\n;|&]*x)/u,
  /\bchmod\s+-r\s+777\b/u,
  /\bchown\s+-r\b/u,
  /\bmkfs(?:\.|\s)/u,
  /\bdd\s+if=/u,
  /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:/u,
  /\b(?:curl|wget)\b[^\n]*(?:\|\s*(?:sh|bash|zsh|fish)|>\s*(?:\/etc\/|~\/\.(?:ssh|config)|.*(?:\.pem|\.key)))/u,
  />\s*\/etc\//u,
  /\b(?:cat|cp|scp|rsync|curl|wget)\b[^\n]*(?:\.env|id_rsa|id_ed25519|\.pem|\.key)/u
];
