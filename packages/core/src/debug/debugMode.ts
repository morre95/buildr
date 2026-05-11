import { matchCommonMistakes, type CommonMistake } from "../memory/commonMistakes.js";
import type { VerificationEvidence } from "../types.js";

export interface DebugObservation {
  source: "diagnostic" | "log" | "test" | "terminal";
  message: string;
  file?: string;
  line?: number;
}

export interface DebugHypothesis {
  id: string;
  title: string;
  confidence: "low" | "medium" | "high";
  evidence: string[];
  suggestedAction: string;
}

export interface DebugSession {
  observations: DebugObservation[];
  matchedMistakes: CommonMistake[];
  hypotheses: DebugHypothesis[];
  verification?: VerificationEvidence;
}

export function createDebugSession(options: {
  observations: DebugObservation[];
  commonMistakes?: CommonMistake[];
  verification?: VerificationEvidence;
}): DebugSession {
  const text = options.observations.map((observation) => observation.message).join("\n");
  const matchedMistakes = matchCommonMistakes(options.commonMistakes ?? [], text);
  const hypotheses = createHypotheses(options.observations, matchedMistakes);

  return {
    observations: options.observations,
    matchedMistakes,
    hypotheses,
    ...(options.verification === undefined ? {} : { verification: options.verification })
  };
}

export function observationsFromLog(content: string): DebugObservation[] {
  return content
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .slice(0, 200)
    .map((line) => ({ source: "log", message: line }));
}

function createHypotheses(observations: DebugObservation[], mistakes: CommonMistake[]): DebugHypothesis[] {
  const hypotheses: DebugHypothesis[] = [];
  const text = observations.map((observation) => observation.message).join("\n").toLowerCase();

  if (text.includes("cannot find module") || text.includes("module not found")) {
    hypotheses.push({
      id: "missing-module",
      title: "Missing dependency or incorrect import path",
      confidence: "high",
      evidence: observations.map((observation) => observation.message).slice(0, 3),
      suggestedAction: "Inspect package dependencies and import paths before proposing a minimal patch."
    });
  }

  if (text.includes("typeerror") || text.includes("undefined is not")) {
    hypotheses.push({
      id: "undefined-access",
      title: "Unexpected undefined value",
      confidence: "medium",
      evidence: observations.map((observation) => observation.message).slice(0, 3),
      suggestedAction: "Trace the failing value to the boundary where it should be initialized or validated."
    });
  }

  for (const mistake of mistakes) {
    hypotheses.push({
      id: `mistake:${mistake.id}`,
      title: `Known project mistake: ${mistake.pattern}`,
      confidence: mistake.severity === "high" ? "high" : "medium",
      evidence: [mistake.avoidanceRule],
      suggestedAction: mistake.avoidanceRule
    });
  }

  if (hypotheses.length === 0) {
    hypotheses.push({
      id: "inspect-context",
      title: "Needs more context",
      confidence: "low",
      evidence: observations.map((observation) => observation.message).slice(0, 3),
      suggestedAction: "Collect related diagnostics, recent terminal output, and relevant files before patching."
    });
  }

  return hypotheses;
}
