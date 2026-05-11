import { createDebugSession, observationsFromLog, readCommonMistakes } from "@buildr/core";
import { readFile } from "node:fs/promises";
import * as vscode from "vscode";

export async function runDebugFromInput(): Promise<void> {
  const source = await vscode.window.showQuickPick([
    {
      label: "Paste log text",
      description: "Paste terminal, test, stack trace, or application output."
    },
    {
      label: "Read log file",
      description: "Read a log file path from disk."
    },
    {
      label: "Use current diagnostics",
      description: "Use VS Code Problems from the current workspace."
    }
  ], {
    title: "Buildr: Debug",
    placeHolder: "Choose the debug input source.",
    ignoreFocusOut: true
  });
  if (source === undefined) {
    return;
  }

  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const mistakes = root === undefined ? [] : await readCommonMistakes(root);
  const observations = await observationsFromSource(source.label);
  const session = createDebugSession({ observations, commonMistakes: mistakes });
  const top = session.hypotheses[0];
  if (top === undefined) {
    vscode.window.showInformationMessage("Buildr Debug Mode found no hypotheses.");
    return;
  }

  vscode.window.showInformationMessage(`Buildr hypothesis: ${top.title} (${top.confidence})`);
}

async function observationsFromSource(source: string) {
  if (source === "Paste log text") {
    const pasted = await vscode.window.showInputBox({
      title: "Buildr: Paste Debug Log",
      prompt: "Paste terminal output, test failure, stack trace, or app log.",
      ignoreFocusOut: true
    });
    return observationsFromLog(pasted ?? "");
  }

  if (source === "Read log file") {
    const logPath = await vscode.window.showInputBox({
      title: "Buildr: Debug Log File",
      prompt: "Path to a log file.",
      ignoreFocusOut: true
    });
    if (logPath === undefined || logPath.trim().length === 0) {
      return [];
    }
    return observationsFromLog(await readFile(logPath.trim(), "utf8"));
  }

  return observationsFromDiagnostics();
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
