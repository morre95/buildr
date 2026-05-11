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
    .map((line) => ({
      source: "log",
      message: line,
      ...extractLocation(line)
    }));
}

function extractLocation(line: string): Pick<DebugObservation, "file" | "line"> {
  const stackMatch = line.match(/\(?((?:[A-Za-z]:)?[./~\w-][^():\s]*\.(?:cjs|css|html|js|jsx|mjs|ts|tsx|json|py|go|rs|java|cs|cpp|c|h)):(\d+)(?::\d+)?\)?/u);
  if (stackMatch?.[1] !== undefined) {
    return {
      file: stackMatch[1],
      ...(stackMatch[2] === undefined ? {} : { line: Number(stackMatch[2]) })
    };
  }
  return {};
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

  if (text.includes("syntaxerror") || text.includes("unexpected token")) {
    hypotheses.push({
      id: "syntax-error",
      title: "Syntax error or invalid source format",
      confidence: "high",
      evidence: observations.map((observation) => observation.message).slice(0, 3),
      suggestedAction: "Open the reported file and line, then fix the malformed token, bracket, import/export, or JSON syntax."
    });
  }

  if (text.includes("referenceerror") || text.includes("is not defined")) {
    hypotheses.push({
      id: "undefined-symbol",
      title: "Referenced symbol is not defined",
      confidence: "high",
      evidence: observations.map((observation) => observation.message).slice(0, 3),
      suggestedAction: "Find the missing variable, function, import, or global and either define it or correct the name."
    });
  }

  if (text.includes("enoent") || text.includes("no such file or directory")) {
    hypotheses.push({
      id: "missing-file",
      title: "Missing file or incorrect path",
      confidence: "high",
      evidence: observations.map((observation) => observation.message).slice(0, 3),
      suggestedAction: "Verify the referenced path, workspace root, generated files, and relative path assumptions."
    });
  }

  if (text.includes("eaddrinuse") || text.includes("address already in use")) {
    hypotheses.push({
      id: "port-in-use",
      title: "Port is already in use",
      confidence: "high",
      evidence: observations.map((observation) => observation.message).slice(0, 3),
      suggestedAction: "Stop the process using the port or configure the app to use a different port."
    });
  }

  if (text.includes("command not found") || text.includes("not recognized as an internal or external command")) {
    hypotheses.push({
      id: "missing-command",
      title: "Required command is unavailable on PATH",
      confidence: "high",
      evidence: observations.map((observation) => observation.message).slice(0, 3),
      suggestedAction: "Check that the tool is installed, available in PATH, and being run from the expected shell/environment."
    });
  }

  if (text.includes("no package.json") || text.includes("no importer manifest") || text.includes("err_pnpm_no_importer_manifest_found")) {
    hypotheses.push({
      id: "missing-package-manifest",
      title: "Package command was run outside a Node package",
      confidence: "high",
      evidence: observations.map((observation) => observation.message).slice(0, 3),
      suggestedAction: "Run the command from a folder containing package.json, create the manifest, or skip package-manager verification for static files."
    });
  }

  if (text.includes("assertionerror") || text.includes("expected") && text.includes("received") || text.includes("failed tests")) {
    hypotheses.push({
      id: "test-assertion-failure",
      title: "Test assertion failed",
      confidence: "medium",
      evidence: observations.map((observation) => observation.message).slice(0, 3),
      suggestedAction: "Inspect the failing assertion and compare the expected behavior with the implementation change."
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
    if (text.trim().split(/\s+/u).filter((term) => term.length > 0).length < 4) {
      hypotheses.push({
        id: "log-too-short",
        title: "Log text is too short to diagnose",
        confidence: "low",
        evidence: observations.map((observation) => observation.message).slice(0, 3),
        suggestedAction: "Paste the full error message, stack trace, command output, or VS Code diagnostic text."
      });
      return hypotheses;
    }

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
