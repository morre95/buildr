import * as vscode from "vscode";
import { spawn } from "node:child_process";

export interface CapturedTaskResult {
  command: string;
  exitCode: number | undefined;
  stdout: string;
  stderr: string;
}

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

export async function runCommandAsVscodeTask(command: string, cwd: string): Promise<CapturedTaskResult> {
  let closeEmitter: vscode.EventEmitter<number | void> | undefined;
  const resultPromise = new Promise<CapturedTaskResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let exitCode: number | undefined;
    const execution = new vscode.CustomExecution(async () => {
      const writeEmitter = new vscode.EventEmitter<string>();
      closeEmitter = new vscode.EventEmitter<number | void>();
      const terminal: vscode.Pseudoterminal = {
        onDidWrite: writeEmitter.event,
        onDidClose: closeEmitter.event,
        open: () => {
          const child = spawn(command, {
            cwd,
            shell: true,
            stdio: ["ignore", "pipe", "pipe"]
          });
          child.stdout.on("data", (chunk: Buffer) => {
            const text = chunk.toString("utf8");
            stdout += text;
            writeEmitter.fire(text.replace(/\n/gu, "\r\n"));
          });
          child.stderr.on("data", (chunk: Buffer) => {
            const text = chunk.toString("utf8");
            stderr += text;
            writeEmitter.fire(text.replace(/\n/gu, "\r\n"));
          });
          child.on("close", (code) => {
            exitCode = code ?? 1;
            closeEmitter?.fire(exitCode);
            writeEmitter.dispose();
            closeEmitter?.dispose();
            resolve({ command, exitCode, stdout, stderr });
          });
        },
        close: () => {
          if (exitCode === undefined) {
            exitCode = 1;
            resolve({ command, exitCode, stdout, stderr });
          }
        }
      };
      return terminal;
    });
    const task = new vscode.Task(
      { type: "buildr-agent-test", command },
      vscode.TaskScope.Workspace,
      `Buildr Agent Test: ${command}`,
      "buildr",
      execution,
      []
    );
    void vscode.tasks.executeTask(task);
  });
  return resultPromise;
}
