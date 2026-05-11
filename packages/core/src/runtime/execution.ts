import type { BuildrPlan } from "../plans/schema.js";
import type { PermissionDecision, ToolResult, VerificationEvidence } from "../types.js";

export type ExecutionStatus = "queued" | "running" | "pending_approval" | "completed" | "blocked" | "failed";

export interface ExecutionEvent {
  id: string;
  title: string;
  status: ExecutionStatus;
  summary: string;
  tool?: string;
  target?: string;
  evidence?: VerificationEvidence;
  warnings: string[];
}

export interface PendingApproval<TPayload = unknown> {
  id: string;
  title: string;
  tool: string;
  target?: string;
  risk: "low" | "medium" | "high";
  details: string;
  payload: TPayload;
}

export interface ExecutionReport {
  plan: BuildrPlan;
  events: ExecutionEvent[];
  pendingApproval?: PendingApproval;
  finalSummary?: string;
}

export function requireTrustedWorkspace(isTrusted: boolean): void {
  if (!isTrusted) {
    throw new Error("Buildr execution is disabled until this workspace is trusted.");
  }
}

export function eventFromToolResult(
  id: string,
  title: string,
  tool: string,
  result: ToolResult,
  target?: string
): ExecutionEvent {
  return {
    id,
    title,
    tool,
    status: result.ok ? "completed" : "failed",
    summary: result.summary,
    warnings: result.warnings,
    ...(target === undefined ? {} : { target })
  };
}

export function eventFromPermissionDecision(
  approval: PendingApproval,
  decision: PermissionDecision
): ExecutionEvent {
  if (decision === "allow") {
    return {
      id: `${approval.id}:approved`,
      title: `${approval.title} approved`,
      status: "running",
      tool: approval.tool,
      summary: `Approved ${approval.tool}.`,
      warnings: [],
      ...(approval.target === undefined ? {} : { target: approval.target })
    };
  }

  return {
    id: `${approval.id}:${decision}`,
    title: `${approval.title} ${decision === "deny" ? "denied" : "needs approval"}`,
    status: decision === "deny" ? "blocked" : "pending_approval",
    tool: approval.tool,
    summary: decision === "deny" ? `Denied ${approval.tool}.` : `${approval.tool} requires approval.`,
    warnings: [],
    ...(approval.target === undefined ? {} : { target: approval.target })
  };
}

export function createFinalSummary(events: ExecutionEvent[]): string {
  const completed = events.filter((event) => event.status === "completed").length;
  const failed = events.filter((event) => event.status === "failed").length;
  const blocked = events.filter((event) => event.status === "blocked").length;

  return `Completed ${completed} step(s), failed ${failed}, blocked ${blocked}.`;
}
