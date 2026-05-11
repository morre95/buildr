export interface WorkspaceTrustState {
  isTrusted: boolean;
  mode: "full" | "read_only_plan";
  disabledCapabilities: string[];
  banner: string;
}

export function getWorkspaceTrustState(isTrusted: boolean): WorkspaceTrustState {
  if (isTrusted) {
    return {
      isTrusted,
      mode: "full",
      disabledCapabilities: [],
      banner: "Workspace is trusted. Buildr execution is available subject to permissions."
    };
  }

  return {
    isTrusted,
    mode: "read_only_plan",
    disabledCapabilities: ["agent_execution", "debug_execution", "terminal", "tasks", "mcp_spawn", "file_writes"],
    banner: "Workspace is untrusted. Buildr is limited to read-only Plan Mode."
  };
}
