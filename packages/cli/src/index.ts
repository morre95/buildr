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
    const goal = args.join(" ");
    const core = new BuildrCore();
    const plan = core.createPlan(goal);
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  } else if (command === "run") {
    const goal = args.join(" ");
    const report = await runReadOnlyPlan(goal);
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

async function runReadOnlyPlan(goal: string): Promise<{ title: string; summary: string; events: ExecutionEvent[]; warnings: string[] }> {
  const core = new BuildrCore();
  const plan = core.createPlan(goal);
  const index = await buildWorkspaceIndex(process.cwd());
  const events: ExecutionEvent[] = [
    {
      id: "plan:create",
      title: "Create plan",
      status: "completed",
      summary: `${plan.steps.length} step(s) planned for: ${plan.goal}`,
      warnings: []
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
    "  buildr plan \"task description\"",
    "  buildr run \"task description\"",
    "  buildr context \"query\"",
    "  buildr index",
    "  buildr mcp list",
    "  buildr doctor",
    "  buildr debug --log ./error.log"
  ].join("\n"));
  process.stderr.write("\n");
}
