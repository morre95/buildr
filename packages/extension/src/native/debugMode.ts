import {
  applyTextPatch,
  BuildrCore,
  createDebugSession,
  createTextPatch,
  observationsFromLog,
  readCommonMistakes,
  type DebugHypothesis,
  type DebugObservation,
  type ProviderId,
  type TextPatch
} from "@buildr/core";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import * as vscode from "vscode";

const MAX_DEBUG_FIX_ITERATIONS = 3;

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

  const action = await vscode.window.showInformationMessage(
    `Buildr hypothesis: ${top.title} (${top.confidence})`,
    "Propose Fix"
  );
  if (action === "Propose Fix") {
    await proposeAndApplyDebugFix(top, observations, 1);
  }
}

async function observationsFromSource(source: string) {
  if (source === "Paste log text") {
    const pasted = await readPastedLogFromEditor();
    return observationsFromLog(pasted);
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

async function readPastedLogFromEditor(): Promise<string> {
  const document = await vscode.workspace.openTextDocument({
    language: "log",
    content: [
      "Paste terminal output, test failure, stack trace, or app log here.",
      "Delete these instruction lines before confirming.",
      ""
    ].join("\n")
  });
  await vscode.window.showTextDocument(document, { preview: false });

  const action = await vscode.window.showInformationMessage(
    "Paste the debug log into the opened editor, then choose Analyze.",
    "Analyze"
  );
  if (action !== "Analyze") {
    return "";
  }

  const activeDocument = vscode.window.activeTextEditor?.document;
  const text = activeDocument?.uri.toString() === document.uri.toString()
    ? activeDocument.getText()
    : document.getText();

  return text
    .replace(/^Paste terminal output, test failure, stack trace, or app log here\.\r?\n/u, "")
    .replace(/^Delete these instruction lines before confirming\.\r?\n/u, "")
    .trim();
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

async function proposeAndApplyDebugFix(hypothesis: DebugHypothesis, observations: DebugObservation[], iteration: number): Promise<void> {
  if (hypothesis.id === "log-too-short" || hypothesis.id === "inspect-context") {
    vscode.window.showWarningMessage("Buildr needs a concrete error and target file before it can propose a fix.");
    return;
  }

  const target = resolveDebugTarget(observations);
  if (target === undefined) {
    vscode.window.showWarningMessage("Buildr could not identify a target file. Open the affected file and run Debug again, or include a file path in the log.");
    return;
  }

  let document: vscode.TextDocument;
  try {
    document = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
  } catch (error) {
    vscode.window.showWarningMessage(`Buildr could not open ${target}: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const currentContent = document.getText();
  const core = createConfiguredCore();
  const modelId = getConfiguredModelId();
  const fix = await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: "Buildr: Proposing debug fix",
    cancellable: false
  }, async () => core.createFileRewriteFromModel({
    goal: createDebugFixGoal(hypothesis, observations),
    modelId,
    path: target,
    currentContent,
    contextSummary: observations.map((observation) => observation.message).slice(0, 40).join("\n")
  }));

  const patch = createTextPatch(target, currentContent, fix.updatedContent);
  const proposed = await vscode.workspace.openTextDocument({
    language: document.languageId,
    content: fix.updatedContent
  });
  await vscode.commands.executeCommand("vscode.diff", document.uri, proposed.uri, `Buildr Debug Fix: ${document.fileName}`);

  const decision = await vscode.window.showWarningMessage(
    `${fix.summary}\n\nApply this debug fix to ${document.fileName}?`,
    { modal: true },
    "Apply Fix"
  );
  if (decision !== "Apply Fix") {
    return;
  }

  await applyDebugPatch(document.uri, patch);
  await inspectDiagnosticsAfterFix(iteration);
}

async function inspectDiagnosticsAfterFix(iteration: number): Promise<void> {
  // Give language servers a short window to refresh Problems after the write.
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 750));

  const remaining = observationsFromDiagnostics().filter((observation) => isWorkspaceObservation(observation));
  if (remaining.length === 0) {
    vscode.window.showInformationMessage("Buildr applied the debug fix. VS Code diagnostics report no remaining workspace problems.");
    return;
  }

  const session = createDebugSession({ observations: remaining });
  const next = session.hypotheses[0];
  if (next === undefined) {
    vscode.window.showWarningMessage(`Buildr applied the debug fix, but ${remaining.length} diagnostic(s) remain.`);
    return;
  }

  if (iteration >= MAX_DEBUG_FIX_ITERATIONS) {
    vscode.window.showWarningMessage(`Buildr applied ${iteration} debug fix pass(es). ${remaining.length} diagnostic(s) still remain; stopping at the safety limit.`);
    return;
  }

  const action = await vscode.window.showWarningMessage(
    `Buildr applied the fix, then found ${remaining.length} remaining diagnostic(s). Next hypothesis: ${next.title} (${next.confidence}).`,
    "Propose Next Fix",
    "Stop"
  );
  if (action === "Propose Next Fix") {
    await proposeAndApplyDebugFix(next, remaining, iteration + 1);
  }
}

function isWorkspaceObservation(observation: DebugObservation): boolean {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (root === undefined || observation.file === undefined) {
    return true;
  }
  const file = isAbsolute(observation.file) ? observation.file : resolve(root, observation.file);
  return file === root || file.startsWith(`${root}/`);
}

function resolveDebugTarget(observations: DebugObservation[]): string | undefined {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const observedFile = observations.find((observation) => observation.file !== undefined)?.file;
  if (observedFile !== undefined) {
    return isAbsolute(observedFile) ? observedFile : root === undefined ? undefined : resolve(root, observedFile);
  }

  const active = vscode.window.activeTextEditor?.document;
  return active?.uri.scheme === "file" ? active.uri.fsPath : undefined;
}

function createDebugFixGoal(hypothesis: DebugHypothesis, observations: DebugObservation[]): string {
  return [
    "Fix the reported error with the smallest safe code change.",
    `Hypothesis: ${hypothesis.title}`,
    `Suggested action: ${hypothesis.suggestedAction}`,
    "",
    "Error evidence:",
    ...observations.map((observation) => {
      const location = observation.file === undefined ? "" : ` (${observation.file}${observation.line === undefined ? "" : `:${observation.line}`})`;
      return `- ${observation.message}${location}`;
    }).slice(0, 30)
  ].join("\n");
}

async function applyDebugPatch(uri: vscode.Uri, patch: TextPatch): Promise<void> {
  const document = await vscode.workspace.openTextDocument(uri);
  const next = applyTextPatch(document.getText(), patch);
  const edit = new vscode.WorkspaceEdit();
  const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
  edit.replace(uri, fullRange, next);
  const applied = await vscode.workspace.applyEdit(edit);
  if (!applied) {
    throw new Error(`VS Code rejected the debug fix for ${uri.fsPath}.`);
  }
  await document.save();
}

function createConfiguredCore(): BuildrCore {
  const modelConfig = vscode.workspace.getConfiguration("buildr.model");
  const provider = modelConfig.get<string>("provider", "ollama");
  const baseUrl = provider === "lmstudio-openai" || provider === "lmstudio-native" || provider === "openai-compatible"
    ? modelConfig.get<string>("lmStudioBaseUrl", "http://127.0.0.1:1234")
    : modelConfig.get<string>("ollamaBaseUrl", "http://127.0.0.1:11434");
  return new BuildrCore({
    model: BuildrCore.createModelAdapter({
      provider: parseProvider(provider),
      baseUrl
    })
  });
}

function getConfiguredModelId(): string {
  return vscode.workspace.getConfiguration("buildr.model").get<string>("modelId", "qwen/qwen3-coder-30b");
}

function parseProvider(value: string): ProviderId {
  if (value === "ollama" || value === "lmstudio-openai" || value === "lmstudio-native" || value === "openai-compatible") {
    return value;
  }
  return "ollama";
}
