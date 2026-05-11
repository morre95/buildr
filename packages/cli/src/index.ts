#!/usr/bin/env node
import {
  BuildrCore,
  buildWorkspaceIndex,
  compressRankedContext,
  createDebugSession,
  createMcpRegistrySnapshot,
  assessRemoteCompatibility,
  loadBuiltInRulePacks,
  loadWorkspaceMcpConfig,
  observationsFromLog,
  rankWorkspaceContext,
  runCompletionGate,
  runMcpDoctor,
  type ExecutionEvent,
  type WorkspaceIndex
} from "@buildr/core";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
  const gate = runCompletionGate({ events, rulePacks: loadBuiltInRulePacks(plan.rulePacks) });
  return {
    title: "Buildr Run",
    summary: gate.summary,
    events,
    warnings: gate.ruleEvaluations.map((evaluation) => evaluation.message)
  };
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
    } else if (arg !== undefined) {
      positionals.push(arg);
    }
  }

  return {
    positionals,
    provider,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(modelId === undefined ? {} : { modelId })
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
    "  buildr plan [--model qwen2.5-coder] [--provider ollama] [--base-url http://127.0.0.1:11434] \"task description\"",
    "  buildr run [--model qwen2.5-coder] \"task description\"",
    "  buildr context \"query\"",
    "  buildr index",
    "  buildr mcp list",
    "  buildr doctor",
    "  buildr debug --log ./error.log"
  ].join("\n"));
  process.stderr.write("\n");
}
