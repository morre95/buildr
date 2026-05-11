#!/usr/bin/env node
import {
  BuildrCore,
  createDebugSession,
  createMcpRegistrySnapshot,
  loadWorkspaceMcpConfig,
  observationsFromLog,
  runMcpDoctor
} from "@buildr/core";
import { readFile } from "node:fs/promises";

const [, , command, ...args] = process.argv;

try {
  if (command === "plan") {
    const goal = args.join(" ");
    const core = new BuildrCore();
    const plan = core.createPlan(goal);
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  } else if (command === "mcp" && args[0] === "list") {
    const snapshot = createMcpRegistrySnapshot(await loadWorkspaceMcpConfig(process.cwd()));
    process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
  } else if (command === "doctor") {
    const result = runMcpDoctor(createMcpRegistrySnapshot(await loadWorkspaceMcpConfig(process.cwd())));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
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

function printUsage(): void {
  process.stderr.write([
    "Usage:",
    "  buildr plan \"task description\"",
    "  buildr mcp list",
    "  buildr doctor",
    "  buildr debug --log ./error.log"
  ].join("\n"));
  process.stderr.write("\n");
}
