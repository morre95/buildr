import * as vscode from "vscode";

export async function findTaskCommand(kind: "build" | "test" | "lint"): Promise<string | undefined> {
  const tasks = await vscode.tasks.fetchTasks();
  const match = tasks.find((task) => {
    const label = task.name.toLowerCase();
    return label.includes(kind);
  });

  if (match?.execution instanceof vscode.ShellExecution) {
    const commandLine = match.execution.commandLine;
    return typeof commandLine === "string" ? commandLine : undefined;
  }

  return undefined;
}
