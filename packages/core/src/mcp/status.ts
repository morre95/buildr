import type { McpServerDefinition } from "./config.js";

export type McpServerStatus = "configured" | "disabled" | "starting" | "ready" | "error";

export interface McpServerHealth {
  serverName: string;
  status: McpServerStatus;
  restartAttempts: number;
  nextRetryMs?: number;
  message: string;
}

export function createInitialMcpStatus(server: McpServerDefinition): McpServerHealth {
  return {
    serverName: server.name,
    status: "configured",
    restartAttempts: 0,
    message: `${server.name} is configured for ${server.type}.`
  };
}

export function nextBackoffMs(restartAttempts: number): number {
  return Math.min(30000, 1000 * 2 ** restartAttempts);
}

export function markMcpServerError(health: McpServerHealth, error: string): McpServerHealth {
  const restartAttempts = health.restartAttempts + 1;
  return {
    serverName: health.serverName,
    status: "error",
    restartAttempts,
    nextRetryMs: nextBackoffMs(restartAttempts),
    message: error
  };
}
