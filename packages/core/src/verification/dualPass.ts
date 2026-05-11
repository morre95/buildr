import type { ExecutionEvent } from "../runtime/execution.js";

export interface VerificationPassResult {
  name: "confirmation" | "adversarial";
  ok: boolean;
  findings: string[];
}

export function runDualVerificationPass(events: ExecutionEvent[]): VerificationPassResult[] {
  const completed = events.filter((event) => event.status === "completed");
  const failedOrBlocked = events.filter((event) => event.status === "failed" || event.status === "blocked");
  const hasEvidence = events.some((event) => event.evidence !== undefined);

  return [
    {
      name: "confirmation",
      ok: completed.length > 0,
      findings: completed.map((event) => event.summary)
    },
    {
      name: "adversarial",
      ok: failedOrBlocked.length === 0 && hasEvidence,
      findings: [
        ...failedOrBlocked.map((event) => `${event.title}: ${event.summary}`),
        ...(hasEvidence ? [] : ["No verification evidence was recorded."])
      ]
    }
  ];
}
