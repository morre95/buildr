export type RuleSeverity = "warn" | "error" | "block_completion";

export interface Rule {
  id: string;
  severity: RuleSeverity;
  text: string;
}

export interface RulePack {
  id: string;
  description: string;
  alwaysApply: boolean;
  rules: Rule[];
}

export interface RuleEvaluation {
  ruleId: string;
  severity: RuleSeverity;
  message: string;
}

export const builtInRulePacks: RulePack[] = [
  {
    id: "agent-behavior",
    description: "Core Buildr agent behavior",
    alwaysApply: true,
    rules: [
      {
        id: "read-before-editing",
        severity: "error",
        text: "Read relevant code and understand existing patterns before editing."
      },
      {
        id: "task-fidelity",
        severity: "error",
        text: "Do exactly what was asked; avoid unrelated refactors or feature additions."
      }
    ]
  },
  {
    id: "verification",
    description: "Evidence-based completion policy",
    alwaysApply: true,
    rules: [
      {
        id: "evidence-over-claims",
        severity: "block_completion",
        text: "Do not claim completion without verification evidence or an explicit skipped-check rationale."
      }
    ]
  },
  {
    id: "git-workflow",
    description: "Scoped, reviewable changes",
    alwaysApply: true,
    rules: [
      {
        id: "diff-first-writes",
        severity: "error",
        text: "Apply file changes through approved diffs and preserve user changes."
      }
    ]
  }
];

export function loadBuiltInRulePacks(ids: string[]): RulePack[] {
  const requested = new Set(ids);
  return builtInRulePacks.filter((pack) => pack.alwaysApply || requested.has(pack.id));
}

const SEVERITY_LABEL: Record<RuleSeverity, string> = {
  warn: "warn",
  error: "required",
  block_completion: "required to complete"
};

/**
 * Render the active rule packs as a system-prompt fragment so warn/error rules
 * influence the agent while it works, rather than only being checked by the
 * completion gate. Returns an empty string when no packs contribute rules.
 */
export function renderRulePackGuidance(rulePacks: RulePack[]): string {
  const lines = rulePacks.flatMap((pack) =>
    pack.rules.map((rule) => `- (${SEVERITY_LABEL[rule.severity]}) ${rule.text}`)
  );
  if (lines.length === 0) {
    return "";
  }
  return ["Follow these project rules while completing the task:", ...lines].join("\n");
}

export function evaluateCompletionRules(options: {
  rulePacks: RulePack[];
  hasVerificationEvidence: boolean;
  skippedVerificationReason?: string;
}): RuleEvaluation[] {
  const evaluations: RuleEvaluation[] = [];
  for (const pack of options.rulePacks) {
    for (const rule of pack.rules) {
      if (
        rule.id === "evidence-over-claims" &&
        !options.hasVerificationEvidence &&
        options.skippedVerificationReason === undefined
      ) {
        evaluations.push({
          ruleId: rule.id,
          severity: rule.severity,
          message: rule.text
        });
      }
    }
  }
  return evaluations;
}
