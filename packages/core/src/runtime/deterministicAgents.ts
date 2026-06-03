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
  /** False when the file does not exist yet and must be created by the coder. */
  exists?: boolean;
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
  "Style: the diff follows the existing project style and keeps changes scoped to this task.",
  "Tests: only when this task's instructions, targetFiles, or acceptanceCriteria call for tests — do not demand verification artifacts that belong to another step."
].join("\n");

export function resolveCoderRetryLimit(configuredLimit: unknown, isLocalModel: boolean): number {
  return typeof configuredLimit === "number" && Number.isInteger(configuredLimit) && configuredLimit > 0
    ? configuredLimit
    : isLocalModel ? 5 : 3;
}

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
    return { status: "changes_needed", issues: normalizeReviewerIssues(value.issues) };
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
    "Each task must contain id, title, instructions, targetFiles, dependsOn, acceptanceCriteria.",
    "targetFiles must be concrete workspace-relative file paths (e.g. src/snake.js, index.html), never descriptions or placeholders.",
    "If the workspace is empty or the file does not exist yet, still provide the exact path you want created."
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
    "Each entry in files includes an exists flag. When exists is false the file does not exist yet: create it with a new-file diff using the provided beforeHash (the hash of empty content). Never refuse because a file is new or empty.",
    "Coder data must be an object with shape: { summary: string, diffs: [{ path: string, beforeHash: string, hunks: [{ oldStart: number, oldLines: number, newStart: number, newLines: number, lines: string[] }] }] }.",
    "Every value must be valid JSON. Do not use JavaScript expressions or string concatenation inside JSON.",
    "Every hunk line must be a single valid JSON string. Escape quotes and backslashes inside code lines.",
    "For new files, use oldStart 0, oldLines 0, newStart 1, newLines equal to the number of added lines, and hunk lines that all start with '+'.",
    "Every hunk line must start with exactly one of: space for context, + for additions, - for removals.",
    "Include 2-3 unchanged context lines immediately before and after each change so it can be located.",
    "oldStart/oldLines/newStart/newLines are approximate hints; the context and removed lines you quote must match the existing file content (copy them verbatim from the provided file).",
    "Do not decide routing, retries, testing, approval, or completion."
  ], options.input);
}

/** A sibling plan task whose deliverables are owned by a different step. */
export interface DeferredTask {
  id: string;
  title: string;
  targetFiles: string[];
}

export function createReviewerMessages(options: {
  requestId: string;
  task: AgentPlanTask;
  coderOutput: CoderOutput;
  deferredWork?: DeferredTask[];
}): ChatMessage[] {
  return createAgentMessages("reviewer", options.requestId, [
    "Review the coder diff against the assigned task only, not the overall goal.",
    "Evaluate the diff solely against this task's instructions, targetFiles, and acceptanceCriteria.",
    "deferredWork lists deliverables owned by other steps. Never raise issues for files or features listed there (e.g. a README, tests, or other modules) — they are implemented in their own steps.",
    "Only return changes_needed for defects in the files this task targets.",
    "Return only { status: 'approved' } or { status: 'changes_needed', issues: [{ category, message }] }.",
    "Each issue is an object whose category is one of correctness, style, or tests, and whose message is a single string.",
    "Do not decide routing, retries, testing, approval, or completion.",
    "",
    "Rubric:",
    REVIEWER_RUBRIC
  ], {
    task: options.task,
    coderOutput: options.coderOutput,
    deferredWork: options.deferredWork ?? []
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
    "Every generated command must be non-interactive and exit on its own.",
    "Do not use watch mode, development servers, REPLs, prompts, or commands that wait for user input.",
    "Prefer one-shot checks such as pnpm test, npm test -- --run, pnpm vitest run, pnpm build, or pnpm lint when they fit the workspace.",
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
  let searchFrom = 0;

  for (const hunk of hunks) {
    const ops = parseHunkOps(hunk.lines, diff.path);
    const expected = ops.filter((op) => op.kind !== "add").map((op) => op.text);
    const location = locateHunk(lines, expected, hunk.oldStart, searchFrom, diff.path);

    const replacement: string[] = [];
    let cursor = location;
    for (const op of ops) {
      if (op.kind === "context") {
        // Preserve the file's own line so its real indentation survives even
        // when the model reproduced the context with different whitespace.
        replacement.push(lines[cursor] ?? op.text);
        cursor += 1;
      } else if (op.kind === "remove") {
        cursor += 1;
      } else {
        replacement.push(op.text);
      }
    }

    lines.splice(location, expected.length, ...replacement);
    searchFrom = location + replacement.length;
  }

  const next = lines.join("\n");
  return hadTrailingNewline || next.length > 0 ? `${next}\n` : next;
}

interface HunkOp {
  kind: "context" | "remove" | "add";
  text: string;
}

function parseHunkOps(hunkLines: string[], path: string): HunkOp[] {
  return hunkLines.map((line) => {
    const text = line.slice(1);
    switch (line[0]) {
      case " ":
        return { kind: "context", text };
      case "-":
        return { kind: "remove", text };
      case "+":
        return { kind: "add", text };
      default:
        throw new Error(`Patch conflict for ${path}: hunk lines must start with space, +, or -.`);
    }
  });
}

// Locate a hunk by matching its context/removal lines against the file rather
// than trusting the model's line numbers and counts. LLMs reproduce line
// content far more reliably than exact indentation or 1-based offsets, so the
// match is whitespace-tolerant and oldStart is only a hint used to disambiguate
// repeated matches and keep multiple hunks in order.
function locateHunk(lines: string[], expected: string[], oldStart: number, searchFrom: number, path: string): number {
  const hint = oldStart <= 0 ? 0 : oldStart - 1;
  if (expected.length === 0) {
    return Math.min(lines.length, Math.max(searchFrom, Math.min(hint, lines.length)));
  }
  let best: number | undefined;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let index = 0; index + expected.length <= lines.length; index += 1) {
    if (!blockMatchesAt(lines, index, expected)) {
      continue;
    }
    const score = (index < searchFrom ? 1_000_000 : 0) + Math.abs(index - hint);
    if (score < bestScore) {
      bestScore = score;
      best = index;
    }
  }
  if (best === undefined) {
    throw new Error(`Patch conflict for ${path}: could not locate the changed lines near line ${oldStart}.`);
  }
  return best;
}

function blockMatchesAt(lines: string[], start: number, expected: string[]): boolean {
  return expected.every((line, offset) => (lines[start + offset] ?? "").trim() === line.trim());
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
    "Every value must be valid JSON. Do not use JavaScript expressions or string concatenation inside JSON.",
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
  assertWorkspacePathArray(value.targetFiles, `tasks[${index}].targetFiles`);
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
  } catch (error) {
    const extracted = extractFirstJsonObject(trimmed);
    if (extracted === undefined) {
      throw new Error("Agent response did not contain a JSON object.");
    }
    try {
      return JSON.parse(extracted);
    } catch {
      const repaired = repairConcatenatedJsonStrings(extracted);
      if (repaired === undefined) {
        throw error;
      }
      return JSON.parse(repaired);
    }
  }
}

function repairConcatenatedJsonStrings(value: string): string | undefined {
  let repaired = "";
  let changed = false;
  let index = 0;

  while (index < value.length) {
    if (value[index] !== "\"") {
      repaired += value[index];
      index += 1;
      continue;
    }

    const first = readJsonStringToken(value, index);
    if (first === undefined) {
      repaired += value[index];
      index += 1;
      continue;
    }

    let combined = first.decoded;
    let end = first.end;
    let cursor = skipWhitespace(value, end);
    let didConcat = false;

    while (value[cursor] === "+") {
      const nextStart = skipWhitespace(value, cursor + 1);
      if (value[nextStart] !== "\"") {
        break;
      }
      const next = readJsonStringToken(value, nextStart);
      if (next === undefined) {
        break;
      }
      combined += next.decoded;
      end = next.end;
      cursor = skipWhitespace(value, end);
      didConcat = true;
    }

    repaired += didConcat ? JSON.stringify(combined) : value.slice(index, first.end);
    changed = changed || didConcat;
    index = end;
  }

  return changed ? repaired : undefined;
}

function readJsonStringToken(value: string, start: number): { decoded: string; end: number } | undefined {
  let escaped = false;
  for (let index = start + 1; index < value.length; index += 1) {
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
      const raw = value.slice(start, index + 1);
      try {
        return { decoded: JSON.parse(raw) as string, end: index + 1 };
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function skipWhitespace(value: string, start: number): number {
  let index = start;
  while (/\s/u.test(value[index] ?? "")) {
    index += 1;
  }
  return index;
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

// Reviewer models follow the categorized rubric and naturally emit issues as
// objects ({ category, message }). Accept both plain strings and those objects,
// normalizing every issue to a single string so downstream rendering is uniform.
function normalizeReviewerIssues(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("issues must be a non-empty array.");
  }
  return value.map((item, index) => normalizeReviewerIssue(item, index));
}

function normalizeReviewerIssue(value: unknown, index: number): string {
  if (typeof value === "string") {
    if (value.trim().length === 0) {
      throw new Error(`issues[${index}] must be a non-empty string.`);
    }
    return value.trim();
  }
  if (isRecord(value)) {
    const detail = firstNonEmptyString(value.message, value.issue, value.description, value.text);
    if (detail === undefined) {
      throw new Error(`issues[${index}] must include a message, issue, or description string.`);
    }
    const category = firstNonEmptyString(value.category, value.type);
    return category === undefined ? detail : `${category}: ${detail}`;
  }
  throw new Error(`issues[${index}] must be a string or an object with a message.`);
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

// Rejects "paths" that are actually descriptions (e.g. "game entrypoint file"),
// absolute paths, or traversal. New files that do not exist yet are still valid
// — the snapshot's exists flag signals that to the coder.
function assertWorkspacePathArray(value: unknown, field: string): asserts value is string[] {
  assertStringArray(value, field);
  value.forEach((path, index) => {
    if (!isPlausibleWorkspacePath(path)) {
      throw new Error(
        `${field}[${index}] must be a concrete workspace-relative file path, not a description: "${path}".`
      );
    }
  });
}

export function isPlausibleWorkspacePath(path: string): boolean {
  const trimmed = path.trim();
  if (trimmed.length === 0) {
    return false;
  }
  if (/\s/u.test(trimmed)) {
    return false; // descriptions contain whitespace; real paths do not
  }
  if (/^(?:[/\\]|[A-Za-z]:[/\\])/u.test(trimmed)) {
    return false; // absolute paths are out of workspace scope
  }
  if (trimmed.split(/[/\\]/u).includes("..")) {
    return false; // parent traversal
  }
  return true;
}

function assertNumber(value: unknown, field: string): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
