#!/usr/bin/env node
import {
  BuildrCore,
  buildWorkspaceIndex,
  compressRankedContext,
  createBuiltInToolRegistry,
  createDebugSession,
  createMcpRegistrySnapshot,
  assessRemoteCompatibility,
  loadBuiltInRulePacks,
  loadWorkspaceMcpConfig,
  MainAgentSession,
  observationsFromLog,
  rankWorkspaceContext,
  renderRulePackGuidance,
  runCompletionGate,
  runMcpDoctor,
  TokenBudgetTracker,
  ToolCallingSession,
  type ChatMessage,
  type ExecutionEvent,
  type TokenBudgetConfig,
  type ToolCallingSessionReport,
  type WorkspaceIndex
} from "@buildr/core";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { renderStepReportToString } from "./renderer.js";

const [, , command, ...args] = process.argv;

try {
  if (command === "plan") {
    const options = parseCliOptions(args);
    const core = createCliCore(options);
    const plan = options.modelId === undefined
      ? core.createPlan(options.positionals.join(" "))
      : (await core.createPlanFromModel({
        goal: options.positionals.join(" "),
        modelId: options.modelId,
        contextSummary: await createCliContextSummary(process.cwd(), options.positionals.join(" "))
      })).plan;
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  } else if (command === "run") {
    const options = parseCliOptions(args);
    const report = await runReadOnlyPlan(options.positionals.join(" "), options);
    process.stdout.write(`${renderStepReportToString(report)}\n`);
  } else if (command === "agent") {
    const options = parseCliOptions(args);
    process.stdout.write(await runToolAgent(options.positionals.join(" "), options));
  } else if (command === "context") {
    const query = args.join(" ");
    const index = await readCachedOrBuildIndex(process.cwd());
    const ranked = rankWorkspaceContext(index, query);
    const compressed = compressRankedContext(ranked);
    process.stdout.write(`${compressed.text || "No relevant context found."}\n`);
  } else if (command === "index") {
    const index = await buildWorkspaceIndex(process.cwd());
    const path = await writeWorkspaceIndex(process.cwd(), index);
    process.stdout.write(`Indexed ${index.files.length} file(s) into ${path}\n`);
  } else if (command === "mcp" && args[0] === "list") {
    const snapshot = createMcpRegistrySnapshot(await loadWorkspaceMcpConfig(process.cwd()));
    process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
  } else if (command === "doctor") {
    const mcp = runMcpDoctor(createMcpRegistrySnapshot(await loadWorkspaceMcpConfig(process.cwd())));
    const remote = assessRemoteCompatibility({
      isTrusted: process.env.BUILDR_WORKSPACE_TRUSTED === "false" ? false : true,
      ...(process.env.VSCODE_REMOTE_NAME === undefined ? {} : { remoteName: process.env.VSCODE_REMOTE_NAME }),
      ...(process.env.BUILDR_MODEL_BASE_URL === undefined ? {} : { modelBaseUrl: process.env.BUILDR_MODEL_BASE_URL }),
      env: process.env
    });
    process.stdout.write(`${JSON.stringify({ mcp, remote }, null, 2)}\n`);
  } else if (command === "debug" && args[0] === "--log" && args[1] !== undefined) {
    const log = await readFile(args[1], "utf8");
    const session = createDebugSession({ observations: observationsFromLog(log) });
    process.stdout.write(`${JSON.stringify(session, null, 2)}\n`);
  } else {
    printUsage();
    process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

interface CliOptions {
  positionals: string[];
  provider: "ollama" | "lmstudio-openai" | "lmstudio-native" | "openai-compatible";
  baseUrl?: string;
  modelId?: string;
  maxParallelSubAgents: number;
  hardTokenCap: number;
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
}

async function runReadOnlyPlan(goal: string, options: CliOptions): Promise<{ title: string; summary: string; events: ExecutionEvent[]; warnings: string[] }> {
  const core = createCliCore(options);
  const planResult = options.modelId === undefined
    ? { plan: core.createPlan(goal), warnings: [] }
    : await core.createPlanFromModel({
      goal,
      modelId: options.modelId,
      contextSummary: await createCliContextSummary(process.cwd(), goal)
    });
  const plan = planResult.plan;
  const index = await buildWorkspaceIndex(process.cwd());
  const events: ExecutionEvent[] = [
    {
      id: "plan:create",
      title: "Create plan",
      status: "completed",
      summary: `${plan.steps.length} step(s) planned for: ${plan.goal}`,
      warnings: planResult.warnings
    },
    {
      id: "context:index",
      title: "Index workspace",
      status: "completed",
      tool: "build_workspace_index",
      target: process.cwd(),
      summary: `Indexed ${index.files.length} file(s).`,
      warnings: []
    }
  ];
  if (options.modelId !== undefined) {
    const targets = await collectCliPlanTargets(process.cwd(), plan);
    if (targets.length > 0) {
      const contextSummary = await createCliContextSummary(process.cwd(), goal);
      const ruleGuidance = renderRulePackGuidance(loadBuiltInRulePacks(plan.rulePacks));
      const sessionOptions = {
        core,
        modelId: options.modelId,
        goal,
        tasks: targets,
        maxParallelSubAgents: options.maxParallelSubAgents,
        tokenBudget: createCliTokenBudgetConfig(options),
        ...(ruleGuidance.length === 0 ? {} : { ruleGuidance })
      };
      const session = new MainAgentSession(contextSummary.length === 0 ? sessionOptions : {
        ...sessionOptions,
        contextSummary
      });
      const report = await session.run();
      events.push({
        id: "agents:parallel",
        title: "Run parallel sub-agents",
        status: report.patchProposals.length > 0 ? "completed" : "failed",
        tool: "main_agent",
        target: process.cwd(),
        summary: `Ran ${report.subAgents.length} sub-agent(s); received ${report.patchProposals.length} patch proposal(s). Tokens: ${report.tokenBudget.totalTokens}/${report.tokenBudget.hardTokenCap}, estimated cost $${report.tokenBudget.estimatedCostUsd.toFixed(6)}.`,
        warnings: report.warnings
      });
    }
  }
  const gate = runCompletionGate({
    events,
    rulePacks: loadBuiltInRulePacks(plan.rulePacks),
    skippedVerificationReason:
      "CLI run is read-only: patches are not applied and verification commands or diagnostics are not executed"
  });
  return {
    title: "Buildr Run",
    summary: gate.summary,
    events,
    warnings: gate.ruleEvaluations.map((evaluation) => evaluation.message)
  };
}

async function runToolAgent(goal: string, options: CliOptions): Promise<string> {
  if (goal.trim().length === 0) {
    throw new Error("Provide a task description for buildr agent.");
  }
  if (options.modelId === undefined) {
    throw new Error("buildr agent requires --model <id>.");
  }
  const root = process.cwd();
  const core = createCliCore(options);
  const contextSummary = await createCliContextSummary(root, goal);
  const session = new ToolCallingSession({
    adapter: core.model,
    modelId: options.modelId,
    messages: createToolAgentMessages(goal, contextSummary),
    registry: createBuiltInToolRegistry({ workspaceRoot: root }),
    budget: new TokenBudgetTracker(createCliTokenBudgetConfig(options)),
    maxParallelTools: options.maxParallelSubAgents
  });
  return renderToolAgentReport(await session.run());
}

function createToolAgentMessages(goal: string, contextSummary: string): ChatMessage[] {
  return [
    {
      role: "system",
      content: [
        "You are Buildr Agent running in a read-only CLI session.",
        "Inspect the workspace with these tools: read_file(path), search_codebase(root, query), propose_patch(path, nextContent).",
        "Paths are relative to the workspace root.",
        "When you need several independent reads or searches, request them together in a single turn so they run in parallel.",
        "apply_patch is unavailable in this read-only session; use propose_patch to suggest changes instead.",
        "When you have enough information, reply with your final answer in plain text and no further tool calls."
      ].join("\n")
    },
    {
      role: "user",
      content: [
        `Task: ${goal}`,
        "",
        "Workspace context summary:",
        contextSummary.trim().length === 0 ? "No workspace context summary is available yet." : contextSummary
      ].join("\n")
    }
  ];
}

function renderToolAgentReport(report: ToolCallingSessionReport): string {
  const lines: string[] = [report.finalText.trim().length > 0 ? report.finalText.trim() : "(no final answer)"];
  if (report.toolExecutions.length > 0) {
    lines.push("", "Tool calls:");
    for (const execution of report.toolExecutions) {
      const status = execution.result.ok ? "ok" : "failed";
      const mode = execution.ranInParallel ? "parallel" : "serial";
      lines.push(`  - ${execution.call.name} [${mode}] ${status}: ${execution.result.summary}`);
    }
  }
  lines.push("", `Iterations: ${report.iterations} (${report.stoppedReason}).`);
  if (report.tokenBudget !== undefined) {
    lines.push(`Tokens: ${report.tokenBudget.totalTokens}/${report.tokenBudget.hardTokenCap}, est. cost $${report.tokenBudget.estimatedCostUsd.toFixed(6)}.`);
  }
  if (report.warnings.length > 0) {
    lines.push("", "Warnings:");
    for (const warning of report.warnings) {
      lines.push(`  - ${warning}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

async function createCliContextSummary(root: string, goal: string): Promise<string> {
  const index = await buildWorkspaceIndex(root);
  return compressRankedContext(rankWorkspaceContext(index, goal, 8), 3000).text;
}

function createCliCore(options: CliOptions): BuildrCore {
  return new BuildrCore({
    model: BuildrCore.createModelAdapter({
      provider: options.provider,
      ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl })
    })
  });
}

function parseCliOptions(args: string[]): CliOptions {
  const positionals: string[] = [];
  let provider: CliOptions["provider"] = "ollama";
  let baseUrl: string | undefined;
  let modelId: string | undefined;
  let maxParallelSubAgents = 3;
  let hardTokenCap = 32000;
  let inputUsdPerMillion = 0;
  let outputUsdPerMillion = 0;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    if (arg === "--provider" && isCliProvider(next)) {
      provider = next;
      index += 1;
    } else if (arg === "--base-url" && next !== undefined) {
      baseUrl = next;
      index += 1;
    } else if (arg === "--model" && next !== undefined) {
      modelId = next;
      index += 1;
    } else if (arg === "--max-parallel-sub-agents" && next !== undefined) {
      maxParallelSubAgents = positiveNumber(next, maxParallelSubAgents);
      index += 1;
    } else if (arg === "--hard-token-cap" && next !== undefined) {
      hardTokenCap = positiveNumber(next, hardTokenCap);
      index += 1;
    } else if (arg === "--input-usd-per-million" && next !== undefined) {
      inputUsdPerMillion = nonNegativeNumber(next, inputUsdPerMillion);
      index += 1;
    } else if (arg === "--output-usd-per-million" && next !== undefined) {
      outputUsdPerMillion = nonNegativeNumber(next, outputUsdPerMillion);
      index += 1;
    } else if (arg !== undefined) {
      positionals.push(arg);
    }
  }

  return {
    positionals,
    provider,
    maxParallelSubAgents,
    hardTokenCap,
    inputUsdPerMillion,
    outputUsdPerMillion,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(modelId === undefined ? {} : { modelId })
  };
}

function positiveNumber(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeNumber(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

async function collectCliPlanTargets(root: string, plan: { steps: Array<{ kind: string; targets: string[]; title: string }> }): Promise<Array<{ id: string; title: string; path: string; currentContent: string }>> {
  const targets: Array<{ id: string; title: string; path: string; currentContent: string }> = [];
  const seen = new Set<string>();
  for (const step of plan.steps) {
    if (step.kind !== "write") {
      continue;
    }
    for (const target of step.targets) {
      const path = resolveCliPlanTarget(root, target);
      if (path === undefined || seen.has(path)) {
        continue;
      }
      seen.add(path);
      targets.push({
        id: `patch_${targets.length + 1}`,
        title: step.title,
        path,
        currentContent: await readTextFileIfExists(path)
      });
    }
  }
  return targets;
}

function resolveCliPlanTarget(root: string, target: string): string | undefined {
  const trimmed = target.trim();
  if (
    trimmed.length === 0 ||
    trimmed === "." ||
    trimmed === "./" ||
    trimmed.includes("${") ||
    trimmed.includes("*") ||
    trimmed.toLowerCase().includes("approved ") ||
    trimmed.endsWith("/")
  ) {
    return undefined;
  }
  const resolved = resolve(root, trimmed);
  const relativePath = relative(root, resolved);
  if (relativePath.startsWith("..") || relativePath === "") {
    return undefined;
  }
  return resolved;
}

async function readTextFileIfExists(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

function createCliTokenBudgetConfig(options: CliOptions): TokenBudgetConfig {
  return {
    hardTokenCap: options.hardTokenCap,
    warningThresholds: [0.7, 0.9],
    costRate: {
      inputUsdPerMillion: options.inputUsdPerMillion,
      outputUsdPerMillion: options.outputUsdPerMillion
    }
  };
}

function isCliProvider(value: string | undefined): value is CliOptions["provider"] {
  return value === "ollama" || value === "lmstudio-openai" || value === "lmstudio-native" || value === "openai-compatible";
}

async function readCachedOrBuildIndex(root: string): Promise<WorkspaceIndex> {
  const path = indexPath(root);
  try {
    return JSON.parse(await readFile(path, "utf8")) as WorkspaceIndex;
  } catch {
    const index = await buildWorkspaceIndex(root);
    await writeWorkspaceIndex(root, index);
    return index;
  }
}

async function writeWorkspaceIndex(root: string, index: WorkspaceIndex): Promise<string> {
  const path = indexPath(root);
  await mkdir(join(root, ".buildr", "index"), { recursive: true });
  await writeFile(path, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  return path;
}

function indexPath(root: string): string {
  return join(root, ".buildr", "index", "workspace-index.json");
}

function printUsage(): void {
  process.stderr.write([
    "Usage:",
    "  buildr plan [--model qwen/qwen3-coder-30b] [--provider ollama] [--base-url http://127.0.0.1:11434] \"task description\"",
    "  buildr run [--model qwen/qwen3-coder-30b] [--hard-token-cap 32000] [--max-parallel-sub-agents 3] \"task description\"",
    "  buildr agent --model qwen/qwen3-coder-30b [--max-parallel-sub-agents 3] \"task description\"",
    "  buildr context \"query\"",
    "  buildr index",
    "  buildr mcp list",
    "  buildr doctor",
    "  buildr debug --log ./error.log"
  ].join("\n"));
  process.stderr.write("\n");
}
