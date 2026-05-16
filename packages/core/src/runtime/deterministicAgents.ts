import { createTextPatch, hashText, type TextPatch } from "../diff/textPatch.js";
import type { ChatMessage } from "../types.js";

export type AgentRole = "architect" | "coder" | "reviewer" | "tester";
export type AgentEnvelopeStatus = "ok" | "blocked";

export interface AgentJsonEnvelope<TData> {
  role: AgentRole;
  version: 1;
  requestId: string;
  status: AgentEnvelopeStatus;
  data: TData;
  warnings: string[];
}

export interface AgentPlanTask {
  id: string;
  title: string;
  instructions: string;
  targetFiles: string[];
  dependsOn: string[];
  acceptanceCriteria: string[];
}

export interface AgentPlan {
  summary: string;
  tasks: AgentPlanTask[];
}

export interface ArchitectOutput {
  plan: AgentPlan;
}

export interface AgentFileSnapshot {
  path: string;
  content: string;
  hash: string;
}

export interface CoderInput {
  task: AgentPlanTask;
  files: AgentFileSnapshot[];
  feedback?: string;
}

export interface AgentDiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

export interface AgentFileDiff {
  path: string;
  beforeHash: string;
  hunks: AgentDiffHunk[];
}

export interface CoderOutput {
  summary: string;
  diffs: AgentFileDiff[];
}

export type ReviewerOutput =
  | { status: "approved" }
  | { status: "changes_needed"; issues: string[] };

export interface AgentTestCase {
  id: string;
  title: string;
  command: string;
}

export interface TestRunObservation {
  id: string;
  command: string;
  exitCode: number | undefined;
  stdout: string;
  stderr: string;
}

export interface TesterOutput {
  testCases: AgentTestCase[];
  result?: {
    status: "passed" | "failed";
    failures: string[];
  };
}

export const REVIEWER_RUBRIC = [
  "Correctness: the diff implements the assigned task without unrelated behavior changes.",
  "Style: the diff follows the existing project style and keeps changes scoped.",
  "Tests present: the change includes or requests appropriate verification for the task."
].join("\n");

export function parseAgentEnvelope<TData>(
  rawResponse: string,
  role: AgentRole,
  requestId: string,
  validateData: (value: unknown) => TData
): AgentJsonEnvelope<TData> {
  const parsed = parseJsonObject(rawResponse);
  if (!isRecord(parsed)) {
    throw new Error(`${role} response must be a JSON object.`);
  }
  if (parsed.role !== role) {
    throw new Error(`${role} response role must be "${role}".`);
  }
  if (parsed.version !== 1) {
    throw new Error(`${role} response version must be 1.`);
  }
  if (parsed.requestId !== requestId) {
    throw new Error(`${role} response requestId must match the request.`);
  }
  if (parsed.status !== "ok" && parsed.status !== "blocked") {
    throw new Error(`${role} response status must be ok or blocked.`);
  }
  if (!Array.isArray(parsed.warnings) || parsed.warnings.some((warning) => typeof warning !== "string")) {
    throw new Error(`${role} response warnings must be an array of strings.`);
  }
  return {
    role,
    version: 1,
    requestId,
    status: parsed.status,
    data: validateData(parsed.data),
    warnings: parsed.warnings
  };
}

export function validateArchitectOutput(value: unknown): ArchitectOutput {
  if (!isRecord(value) || !isRecord(value.plan)) {
    throw new Error("Architect data must contain plan.");
  }
  const plan = value.plan;
  assertString(plan.summary, "plan.summary");
  if (!Array.isArray(plan.tasks) || plan.tasks.length === 0) {
    throw new Error("plan.tasks must contain at least one task.");
  }
  return {
    plan: {
      summary: plan.summary,
      tasks: plan.tasks.map(validateAgentPlanTask)
    }
  };
}

export function validateCoderOutput(value: unknown): CoderOutput {
  if (!isRecord(value)) {
    throw new Error("Coder data must be an object.");
  }
  assertString(value.summary, "summary");
  if (!Array.isArray(value.diffs)) {
    throw new Error("diffs must be an array.");
  }
  return {
    summary: value.summary,
    diffs: value.diffs.map(validateAgentFileDiff)
  };
}

export function validateReviewerOutput(value: unknown): ReviewerOutput {
  if (!isRecord(value)) {
    throw new Error("Reviewer data must be an object.");
  }
  if (value.status === "approved") {
    return { status: "approved" };
  }
  if (value.status === "changes_needed") {
    assertStringArray(value.issues, "issues");
    return { status: "changes_needed", issues: value.issues };
  }
  throw new Error("Reviewer status must be approved or changes_needed.");
}

export function validateTesterOutput(value: unknown): TesterOutput {
  if (!isRecord(value)) {
    throw new Error("Tester data must be an object.");
  }
  const testCases = Array.isArray(value.testCases) ? value.testCases.map(validateAgentTestCase) : [];
  const result = value.result === undefined ? undefined : validateTestResult(value.result);
  return result === undefined ? { testCases } : { testCases, result };
}

export function createArchitectMessages(options: {
  requestId: string;
  rawTask: string;
  workspaceTree: string[];
  workspaceSummary: string;
}): ChatMessage[] {
  return createAgentMessages("architect", options.requestId, [
    "Create an ordered implementation plan for this workspace.",
    "Do not decide routing. The orchestrator owns every next step.",
    "Return data.plan as { summary, tasks }.",
    "Each task must contain id, title, instructions, targetFiles, dependsOn, acceptanceCriteria."
  ], {
    rawTask: options.rawTask,
    workspaceTree: options.workspaceTree,
    workspaceSummary: options.workspaceSummary
  });
}

export function createCoderMessages(options: {
  requestId: string;
  input: CoderInput;
}): ChatMessage[] {
  return createAgentMessages("coder", options.requestId, [
    "Implement exactly the assigned task.",
    "Return structured diffs only, never full files.",
    "Use workspace-relative paths and the provided beforeHash for every file diff.",
    "Coder data must be an object with shape: { summary: string, diffs: [{ path: string, beforeHash: string, hunks: [{ oldStart: number, oldLines: number, newStart: number, newLines: number, lines: string[] }] }] }.",
    "For new files, use oldStart 0, oldLines 0, newStart 1, newLines equal to the number of added lines, and hunk lines that all start with '+'.",
    "Every hunk line must start with exactly one of: space for context, + for additions, - for removals.",
    "Do not decide routing, retries, testing, approval, or completion."
  ], options.input);
}

export function createReviewerMessages(options: {
  requestId: string;
  task: AgentPlanTask;
  coderOutput: CoderOutput;
}): ChatMessage[] {
  return createAgentMessages("reviewer", options.requestId, [
    "Review the coder diff against the original task and fixed rubric.",
    "Return only { status: 'approved' } or { status: 'changes_needed', issues }.",
    "Do not decide routing, retries, testing, approval, or completion.",
    "",
    "Rubric:",
    REVIEWER_RUBRIC
  ], {
    task: options.task,
    coderOutput: options.coderOutput
  });
}

export function createTesterMessages(options: {
  requestId: string;
  plan: AgentPlan;
  observations?: TestRunObservation[];
}): ChatMessage[] {
  return createAgentMessages("tester", options.requestId, [
    options.observations === undefined
      ? "Generate test cases for the completed plan. Return commands for the extension to execute."
      : "Inspect the supplied stdout/stderr observations and return a structured pass/fail result.",
    "Do not claim you ran tests yourself.",
    "Do not decide routing, retries, approval, or completion."
  ], {
    plan: options.plan,
    observations: options.observations ?? []
  });
}

export function applyAgentFileDiff(current: string, diff: AgentFileDiff): string {
  if (hashText(current) !== diff.beforeHash) {
    throw new Error(`Patch conflict for ${diff.path}: file hash does not match beforeHash.`);
  }
  const hadTrailingNewline = current.endsWith("\n");
  const lines = current.length === 0 ? [] : current.replace(/\n$/u, "").split("\n");
  const hunks = normalizeAgentDiffHunks(current, diff);
  let offset = 0;

  for (const hunk of hunks) {
    const start = hunk.oldStart <= 0 ? 0 : hunk.oldStart - 1 + offset;
    const replacement: string[] = [];
    let cursor = start;
    let removed = 0;

    for (const line of hunk.lines) {
      const prefix = line[0];
      const text = line.slice(1);
      if (prefix === " ") {
        if (lines[cursor] !== text) {
          throw new Error(`Patch conflict for ${diff.path}: context mismatch at line ${cursor + 1}.`);
        }
        replacement.push(text);
        cursor += 1;
        removed += 1;
      } else if (prefix === "-") {
        if (lines[cursor] !== text) {
          throw new Error(`Patch conflict for ${diff.path}: removal mismatch at line ${cursor + 1}.`);
        }
        cursor += 1;
        removed += 1;
      } else if (prefix === "+") {
        replacement.push(text);
      } else {
        throw new Error(`Patch conflict for ${diff.path}: hunk lines must start with space, +, or -.`);
      }
    }

    if (removed !== hunk.oldLines) {
      throw new Error(`Patch conflict for ${diff.path}: hunk oldLines does not match removed/context lines.`);
    }
    const added = replacement.length;
    if (added !== hunk.newLines) {
      throw new Error(`Patch conflict for ${diff.path}: hunk newLines does not match added/context lines.`);
    }
    lines.splice(start, removed, ...replacement);
    offset += added - removed;
  }

  const next = lines.join("\n");
  return hadTrailingNewline || next.length > 0 ? `${next}\n` : next;
}

export function createTextPatchFromAgentDiff(current: string, diff: AgentFileDiff, absolutePath: string): TextPatch {
  return createTextPatch(absolutePath, current, applyAgentFileDiff(current, diff));
}

function normalizeAgentDiffHunks(current: string, diff: AgentFileDiff): AgentDiffHunk[] {
  if (current.length !== 0) {
    return diff.hunks;
  }
  return diff.hunks.map((hunk) => {
    const lines = hunk.lines
      .filter((line) => !line.startsWith("\\ No newline at end of file"))
      .map((line) => line.startsWith("+") ? line : `+${line}`);
    return {
      ...hunk,
      oldStart: 0,
      oldLines: 0,
      lines,
      newLines: lines.length
    };
  });
}

function createAgentMessages(role: AgentRole, requestId: string, instructions: string[], payload: unknown): ChatMessage[] {
  const envelope = [
    "Return only JSON. Do not wrap the JSON in Markdown.",
    `The JSON envelope must be exactly: {"role":"${role}","version":1,"requestId":"${requestId}","status":"ok","data":...,"warnings":[]}.`,
    "Use status blocked only when the requested role cannot produce valid data."
  ].join("\n");
  return [
    {
      role: "system",
      content: [
        `You are the deterministic ${role} agent.`,
        envelope,
        ...instructions
      ].join("\n")
    },
    {
      role: "user",
      content: JSON.stringify(payload, null, 2)
    }
  ];
}

function validateAgentPlanTask(value: unknown, index: number): AgentPlanTask {
  if (!isRecord(value)) {
    throw new Error(`tasks[${index}] must be an object.`);
  }
  assertString(value.id, `tasks[${index}].id`);
  assertString(value.title, `tasks[${index}].title`);
  assertString(value.instructions, `tasks[${index}].instructions`);
  assertStringArray(value.targetFiles, `tasks[${index}].targetFiles`);
  assertStringArray(value.dependsOn, `tasks[${index}].dependsOn`);
  assertStringArray(value.acceptanceCriteria, `tasks[${index}].acceptanceCriteria`);
  return {
    id: value.id,
    title: value.title,
    instructions: value.instructions,
    targetFiles: value.targetFiles,
    dependsOn: value.dependsOn,
    acceptanceCriteria: value.acceptanceCriteria
  };
}

function validateAgentFileDiff(value: unknown, index: number): AgentFileDiff {
  if (!isRecord(value)) {
    throw new Error(`diffs[${index}] must be an object.`);
  }
  assertString(value.path, `diffs[${index}].path`);
  assertString(value.beforeHash, `diffs[${index}].beforeHash`);
  if (!Array.isArray(value.hunks)) {
    throw new Error(`diffs[${index}].hunks must be an array.`);
  }
  return {
    path: value.path,
    beforeHash: value.beforeHash,
    hunks: value.hunks.map(validateAgentDiffHunk)
  };
}

function validateAgentDiffHunk(value: unknown, index: number): AgentDiffHunk {
  if (!isRecord(value)) {
    throw new Error(`hunks[${index}] must be an object.`);
  }
  assertNumber(value.oldStart, `hunks[${index}].oldStart`);
  assertNumber(value.oldLines, `hunks[${index}].oldLines`);
  assertNumber(value.newStart, `hunks[${index}].newStart`);
  assertNumber(value.newLines, `hunks[${index}].newLines`);
  assertStringArray(value.lines, `hunks[${index}].lines`);
  return {
    oldStart: value.oldStart,
    oldLines: value.oldLines,
    newStart: value.newStart,
    newLines: value.newLines,
    lines: value.lines
  };
}

function validateAgentTestCase(value: unknown, index: number): AgentTestCase {
  if (!isRecord(value)) {
    throw new Error(`testCases[${index}] must be an object.`);
  }
  assertString(value.id, `testCases[${index}].id`);
  assertString(value.title, `testCases[${index}].title`);
  assertString(value.command, `testCases[${index}].command`);
  return {
    id: value.id,
    title: value.title,
    command: value.command
  };
}

function validateTestResult(value: unknown): TesterOutput["result"] {
  if (!isRecord(value)) {
    throw new Error("result must be an object.");
  }
  if (value.status !== "passed" && value.status !== "failed") {
    throw new Error("result.status must be passed or failed.");
  }
  assertStringArray(value.failures, "result.failures");
  return {
    status: value.status,
    failures: value.failures
  };
}

function parseJsonObject(rawResponse: string): unknown {
  const trimmed = rawResponse.trim();
  if (trimmed.length === 0) {
    throw new Error("Agent returned an empty response.");
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    const extracted = extractFirstJsonObject(trimmed);
    if (extracted === undefined) {
      throw new Error("Agent response did not contain a JSON object.");
    }
    return JSON.parse(extracted);
  }
}

function extractFirstJsonObject(value: string): string | undefined {
  const start = value.indexOf("{");
  if (start < 0) {
    return undefined;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const char = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return value.slice(start, index + 1);
      }
    }
  }
  return undefined;
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

function assertNumber(value: unknown, field: string): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
