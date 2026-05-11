#!/usr/bin/env node
import { BuildrCore } from "@buildr/core";

const [, , command, ...args] = process.argv;

if (command === "plan") {
  const goal = args.join(" ");
  const core = new BuildrCore();
  const plan = core.createPlan(goal);
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
} else {
  process.stderr.write("Usage: buildr plan \"task description\"\n");
  process.exitCode = 1;
}
