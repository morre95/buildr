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
  if (!isRecord(plan.verification)) {
    throw new Error("verification must be an object.");
  }
  if (!Array.isArray(plan.steps) || plan.steps.length === 0) {
    throw new Error("steps must contain at least one step.");
  }

  return plan as BuildrPlan;
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
