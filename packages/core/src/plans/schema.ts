export type PlanStepKind = "read" | "write" | "verify";
export type PlanRisk = "low" | "medium" | "high";

export interface VerificationContract {
  required: boolean;
  levels: Array<"diagnostics" | "lint" | "tests" | "build">;
  commands: string[];
  allowUnverifiedCompletion: "ask" | "never" | "always";
  includeOutputEvidence: boolean;
}

export interface PlanStep {
  id: string;
  title: string;
  kind: PlanStepKind;
  tools: string[];
  targets: string[];
  dependsOn: string[];
  risk: PlanRisk;
  verification?: string[];
  scopeCheck?: string;
  requiredEvidence?: string[];
}

export interface BuildrPlan {
  goal: string;
  acceptanceCriteria: string[];
  scopeBoundaries: string[];
  rulePacks: string[];
  verification: VerificationContract;
  steps: PlanStep[];
}

export function createDefaultPlan(goal: string): BuildrPlan {
  const trimmedGoal = goal.trim();
  if (trimmedGoal.length === 0) {
    throw new Error("A plan goal is required.");
  }

  return {
    goal: trimmedGoal,
    acceptanceCriteria: [
      "Requested change is implemented within the approved scope.",
      "Verification evidence is recorded before completion."
    ],
    scopeBoundaries: [
      "Do not edit unrelated files.",
      "Do not run side-effecting commands without approval."
    ],
    rulePacks: ["agent-behavior", "verification", "git-workflow"],
    verification: {
      required: true,
      levels: ["diagnostics"],
      commands: [],
      allowUnverifiedCompletion: "ask",
      includeOutputEvidence: true
    },
    steps: [
      {
        id: "inspect",
        title: "Inspect relevant context",
        kind: "read",
        tools: ["read_file", "search_codebase", "read_diagnostics"],
        targets: ["${workspaceFolder}"],
        dependsOn: [],
        risk: "low",
        verification: ["Summarize observed context with provenance."]
      },
      {
        id: "propose",
        title: "Propose scoped patch",
        kind: "write",
        tools: ["propose_patch", "apply_patch"],
        targets: ["approved plan targets"],
        dependsOn: ["inspect"],
        risk: "medium",
        scopeCheck: "Patch must stay inside approved targets."
      },
      {
        id: "verify",
        title: "Run verification contract",
        kind: "verify",
        tools: ["read_diagnostics", "run_terminal"],
        targets: ["approved verification commands"],
        dependsOn: ["propose"],
        risk: "medium",
        requiredEvidence: ["command", "exitCode", "outputExcerpt", "diagnosticsSummary"]
      }
    ]
  };
}

export function validatePlan(value: unknown): BuildrPlan {
  if (!isRecord(value)) {
    throw new Error("Plan must be an object.");
  }

  const plan = value as Partial<BuildrPlan>;
  assertString(plan.goal, "goal");
  assertStringArray(plan.acceptanceCriteria, "acceptanceCriteria");
  assertStringArray(plan.scopeBoundaries, "scopeBoundaries");
  assertStringArray(plan.rulePacks, "rulePacks");
  assertVerificationContract(plan.verification);
  if (!Array.isArray(plan.steps) || plan.steps.length === 0) {
    throw new Error("steps must contain at least one step.");
  }
  for (const [index, step] of plan.steps.entries()) {
    assertPlanStep(step, index);
  }

  return plan as BuildrPlan;
}

export function normalizePlan(value: unknown, fallbackGoal: string): BuildrPlan {
  const fallback = createDefaultPlan(fallbackGoal);
  if (!isRecord(value)) {
    return fallback;
  }

  const candidate = value as Partial<BuildrPlan>;
  const normalized: BuildrPlan = {
    goal: typeof candidate.goal === "string" && candidate.goal.trim().length > 0 ? candidate.goal.trim() : fallback.goal,
    acceptanceCriteria: normalizeStringArray(candidate.acceptanceCriteria, fallback.acceptanceCriteria),
    scopeBoundaries: normalizeStringArray(candidate.scopeBoundaries, fallback.scopeBoundaries),
    rulePacks: normalizeStringArray(candidate.rulePacks, fallback.rulePacks),
    verification: normalizeVerification(candidate.verification, fallback.verification),
    steps: normalizeSteps(candidate.steps, fallback.steps)
  };

  return validatePlan(normalized);
}

function assertString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
}

function assertStringArray(value: unknown, field: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${field} must be an array of strings.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertVerificationContract(value: unknown): asserts value is VerificationContract {
  if (!isRecord(value)) {
    throw new Error("verification must be an object.");
  }
  if (typeof value.required !== "boolean") {
    throw new Error("verification.required must be a boolean.");
  }
  assertStringArray(value.levels, "verification.levels");
  assertStringArray(value.commands, "verification.commands");
  if (value.allowUnverifiedCompletion !== "ask" && value.allowUnverifiedCompletion !== "never" && value.allowUnverifiedCompletion !== "always") {
    throw new Error("verification.allowUnverifiedCompletion must be ask, never, or always.");
  }
  if (typeof value.includeOutputEvidence !== "boolean") {
    throw new Error("verification.includeOutputEvidence must be a boolean.");
  }
}

function assertPlanStep(value: unknown, index: number): asserts value is PlanStep {
  if (!isRecord(value)) {
    throw new Error(`steps[${index}] must be an object.`);
  }
  assertString(value.id, `steps[${index}].id`);
  assertString(value.title, `steps[${index}].title`);
  if (value.kind !== "read" && value.kind !== "write" && value.kind !== "verify") {
    throw new Error(`steps[${index}].kind must be read, write, or verify.`);
  }
  assertStringArray(value.tools, `steps[${index}].tools`);
  assertStringArray(value.targets, `steps[${index}].targets`);
  assertStringArray(value.dependsOn, `steps[${index}].dependsOn`);
  if (value.risk !== "low" && value.risk !== "medium" && value.risk !== "high") {
    throw new Error(`steps[${index}].risk must be low, medium, or high.`);
  }
}

function normalizeStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) {
    return fallback;
  }
  const items = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
  return items.length > 0 ? items : fallback;
}

function normalizeVerification(value: unknown, fallback: VerificationContract): VerificationContract {
  if (!isRecord(value)) {
    return fallback;
  }

  return {
    required: typeof value.required === "boolean" ? value.required : fallback.required,
    levels: normalizeVerificationLevels(value.levels, fallback.levels),
    commands: normalizeStringArray(value.commands, fallback.commands),
    allowUnverifiedCompletion: normalizeAllowUnverifiedCompletion(value.allowUnverifiedCompletion, fallback.allowUnverifiedCompletion),
    includeOutputEvidence: typeof value.includeOutputEvidence === "boolean" ? value.includeOutputEvidence : fallback.includeOutputEvidence
  };
}

function normalizeVerificationLevels(value: unknown, fallback: VerificationContract["levels"]): VerificationContract["levels"] {
  if (!Array.isArray(value)) {
    return fallback;
  }
  const allowed = new Set(["diagnostics", "lint", "tests", "build"]);
  const levels = value.filter((item): item is VerificationContract["levels"][number] => typeof item === "string" && allowed.has(item));
  return levels.length > 0 ? levels : fallback;
}

function normalizeAllowUnverifiedCompletion(value: unknown, fallback: VerificationContract["allowUnverifiedCompletion"]): VerificationContract["allowUnverifiedCompletion"] {
  return value === "ask" || value === "never" || value === "always" ? value : fallback;
}

function normalizeSteps(value: unknown, fallback: PlanStep[]): PlanStep[] {
  if (!Array.isArray(value)) {
    return fallback;
  }

  const steps = value.flatMap((item, index): PlanStep[] => {
    if (!isRecord(item)) {
      return [];
    }
    const fallbackStep = fallback[Math.min(index, fallback.length - 1)] ?? fallback[0];
    if (fallbackStep === undefined) {
      return [];
    }
    return [{
      id: typeof item.id === "string" && item.id.trim().length > 0 ? item.id.trim() : `step-${index + 1}`,
      title: typeof item.title === "string" && item.title.trim().length > 0 ? item.title.trim() : fallbackStep.title,
      kind: item.kind === "read" || item.kind === "write" || item.kind === "verify" ? item.kind : fallbackStep.kind,
      tools: normalizeStringArray(item.tools, fallbackStep.tools),
      targets: normalizeStringArray(item.targets, fallbackStep.targets),
      dependsOn: Array.isArray(item.dependsOn) ? item.dependsOn.filter((dependency): dependency is string => typeof dependency === "string") : [],
      risk: item.risk === "low" || item.risk === "medium" || item.risk === "high" ? item.risk : fallbackStep.risk,
      ...(Array.isArray(item.verification) ? { verification: item.verification.filter((entry): entry is string => typeof entry === "string") } : {}),
      ...(typeof item.scopeCheck === "string" ? { scopeCheck: item.scopeCheck } : {}),
      ...(Array.isArray(item.requiredEvidence) ? { requiredEvidence: item.requiredEvidence.filter((entry): entry is string => typeof entry === "string") } : {})
    }];
  });

  return steps.length > 0 ? steps : fallback;
}
