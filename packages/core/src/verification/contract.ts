import { spawn } from "node:child_process";
import type { VerificationEvidence } from "../types.js";

export interface RunCommandOptions {
  cwd: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export async function runVerificationCommand(
  command: string,
  options: RunCommandOptions
): Promise<VerificationEvidence> {
  const timeoutMs = options.timeoutMs ?? 120000;

  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd: options.cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let output = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
    }, timeoutMs);

    options.signal?.addEventListener("abort", () => {
      child.kill("SIGTERM");
    });

    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      resolve({
        command,
        exitCode: exitCode ?? 1,
        outputExcerpt: output.slice(-4000)
      });
    });
  });
}

export function summarizeDiagnostics(count: number): VerificationEvidence {
  return {
    diagnosticsSummary: count === 0 ? "No diagnostics reported." : `${count} diagnostic(s) reported.`
  };
}
