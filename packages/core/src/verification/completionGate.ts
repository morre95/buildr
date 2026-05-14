import type { ExecutionEvent } from "../runtime/execution.js";
import { evaluateCompletionRules, type RuleEvaluation, type RulePack } from "../rules/ruleEngine.js";

export interface CompletionGateResult {
  status: "complete" | "blocked" | "complete_with_risks";
  summary: string;
  ruleEvaluations: RuleEvaluation[];
  verificationEvents: ExecutionEvent[];
}

export function runCompletionGate(options: {
  events: ExecutionEvent[];
  rulePacks: RulePack[];
  skippedVerificationReason?: string;
}): CompletionGateResult {
  const verificationEvents = options.events.filter(
    (event) => event.evidence !== undefined || event.tool === "run_terminal" || event.tool === "read_diagnostics"
  );
  const hasVerificationEvidence = verificationEvents.some(
    (event) => event.evidence !== undefined && event.status !== "failed"
  );
  const ruleEvaluations = evaluateCompletionRules({
    rulePacks: options.rulePacks,
    hasVerificationEvidence,
    ...(options.skippedVerificationReason === undefined ? {} : { skippedVerificationReason: options.skippedVerificationReason })
  });
  const hasBlockingRule = ruleEvaluations.some((evaluation) => evaluation.severity === "block_completion");
  const hasFailures = options.events.some((event) => event.status === "failed" || event.status === "blocked");

  if (hasBlockingRule) {
    return {
      status: "blocked",
      summary: "Completion blocked because required verification evidence is missing.",
      ruleEvaluations,
      verificationEvents
    };
  }

  if (hasFailures || ruleEvaluations.length > 0) {
    return {
      status: "complete_with_risks",
      summary: "Completion has unresolved risks.",
      ruleEvaluations,
      verificationEvents
    };
  }

  if (options.skippedVerificationReason !== undefined && !hasVerificationEvidence) {
    return {
      status: "complete",
      summary: `Run finished without executable verification (${options.skippedVerificationReason}).`,
      ruleEvaluations,
      verificationEvents
    };
  }

  return {
    status: "complete",
    summary: "Completion gate passed with verification evidence.",
    ruleEvaluations,
    verificationEvents
  };
}
