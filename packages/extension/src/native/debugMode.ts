import { createDebugSession, observationsFromLog, readCommonMistakes } from "@buildr/core";
import { readFile } from "node:fs/promises";
import * as vscode from "vscode";

export async function runDebugFromInput(): Promise<void> {
  const logPath = await vscode.window.showInputBox({
    title: "Buildr: Debug Log",
    prompt: "Optional path to a log file. Leave blank to use current diagnostics.",
    ignoreFocusOut: true
  });

  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const mistakes = root === undefined ? [] : await readCommonMistakes(root);
  const observations = logPath === undefined || logPath.length === 0
    ? observationsFromDiagnostics()
    : observationsFromLog(await readFile(logPath, "utf8"));
  const session = createDebugSession({ observations, commonMistakes: mistakes });
  const top = session.hypotheses[0];
  if (top === undefined) {
    vscode.window.showInformationMessage("Buildr Debug Mode found no hypotheses.");
    return;
  }

  vscode.window.showInformationMessage(`Buildr hypothesis: ${top.title} (${top.confidence})`);
}

function observationsFromDiagnostics() {
  return vscode.languages.getDiagnostics().flatMap(([uri, diagnostics]) =>
    diagnostics.map((diagnostic) => ({
      source: "diagnostic" as const,
      message: diagnostic.message,
      file: uri.fsPath,
      line: diagnostic.range.start.line + 1
    }))
  );
}
