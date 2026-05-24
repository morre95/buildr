import * as vscode from "vscode";
import { spawn } from "node:child_process";

const DEFAULT_TASK_TIMEOUT_MS = 120000;

export interface CapturedTaskResult {
  command: string;
  exitCode: number | undefined;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export interface RunCommandAsVscodeTaskOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
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

export async function runCommandAsVscodeTask(
  command: string,
  cwd: string,
  options: RunCommandAsVscodeTaskOptions = {}
): Promise<CapturedTaskResult> {
  let closeEmitter: vscode.EventEmitter<number | void> | undefined;
  const timeoutMs = Math.max(1000, Math.floor(options.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS));
  const resultPromise = new Promise<CapturedTaskResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let exitCode: number | undefined;
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    let child: ReturnType<typeof spawn> | undefined;
    let timedOut = false;

    const finish = (result: CapturedTaskResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      options.signal?.removeEventListener("abort", abort);
      closeEmitter?.fire(result.exitCode ?? 1);
      closeEmitter?.dispose();
      resolve(result);
    };
    const abort = (): void => {
      stderr += "\nBuildr stopped the approved command before it completed.\n";
      child?.kill("SIGTERM");
      finish({ command, exitCode: 1, stdout, stderr, timedOut });
    };

    const execution = new vscode.CustomExecution(async () => {
      const writeEmitter = new vscode.EventEmitter<string>();
      closeEmitter = new vscode.EventEmitter<number | void>();
      const terminal: vscode.Pseudoterminal = {
        onDidWrite: writeEmitter.event,
        onDidClose: closeEmitter.event,
        open: () => {
          child = spawn(command, {
            cwd,
            shell: true,
            stdio: ["ignore", "pipe", "pipe"]
          });
          timeout = setTimeout(() => {
            timedOut = true;
            exitCode = 1;
            const message = `\nBuildr timed out the approved command after ${timeoutMs}ms.\n`;
            stderr += message;
            writeEmitter.fire(message.replace(/\n/gu, "\r\n"));
            child?.kill("SIGTERM");
            finish({ command, exitCode, stdout, stderr, timedOut });
            writeEmitter.dispose();
          }, timeoutMs);
          options.signal?.addEventListener("abort", abort, { once: true });
          child.stdout?.on("data", (chunk: Buffer) => {
            const text = chunk.toString("utf8");
            stdout += text;
            writeEmitter.fire(text.replace(/\n/gu, "\r\n"));
          });
          child.stderr?.on("data", (chunk: Buffer) => {
            const text = chunk.toString("utf8");
            stderr += text;
            writeEmitter.fire(text.replace(/\n/gu, "\r\n"));
          });
          child.on("close", (code) => {
            if (settled) {
              return;
            }
            exitCode = code ?? 1;
            writeEmitter.dispose();
            finish({ command, exitCode, stdout, stderr, timedOut });
          });
        },
        close: () => {
          if (exitCode === undefined) {
            exitCode = 1;
            child?.kill("SIGTERM");
            finish({ command, exitCode, stdout, stderr, timedOut });
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
