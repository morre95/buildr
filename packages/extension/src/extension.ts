import {
  applyTextPatch,
  buildWorkspaceIndex,
  BuildrCore,
  checkScopeFidelity,
  compressRankedContext,
  createFinalSummary,
  createTextPatch,
  eventFromPermissionDecision,
  loadBuiltInRulePacks,
  rankWorkspaceContext,
  requireTrustedWorkspace,
  runCompletionGate,
  runVerificationCommand,
  searchCodebaseTool,
  type BuildrPlan,
  type ExecutionEvent,
  type ModelAdapter,
  type ModelInfo,
  type PendingApproval,
  type ProviderId,
  type TextPatch
} from "@buildr/core";
import * as vscode from "vscode";
import { BuildrSecretStore } from "./credentials.js";
import { registerBuildrChatParticipant } from "./native/chatParticipant.js";
import { runDebugFromInput } from "./native/debugMode.js";
import { readDiagnosticsSummary } from "./native/diagnostics.js";
import { registerBuildrLanguageModelTools } from "./native/languageModelTools.js";
import { showMcpDoctor, showMcpList } from "./native/mcpCommands.js";
import { openBuildrSettings } from "./native/settings.js";
import { findTaskCommand } from "./native/tasks.js";
import { type ApprovalMessage, StepPanel } from "./webview/stepPanel.js";

let activeAbortController: AbortController | undefined;
let currentPlan: BuildrPlan | undefined;
let events: ExecutionEvent[] = [];
let pendingApproval: PendingApproval<TextPatch | TerminalApprovalPayload> | undefined;
let queuedVerificationCommand: string | undefined;

interface TerminalApprovalPayload {
  command: string;
  cwd: string;
}

export function activate(context: vscode.ExtensionContext): void {
  const core = new BuildrCore();
  const stepPanel = new StepPanel(context.extensionUri);
  const secretStore = new BuildrSecretStore(context.secrets);
  registerBuildrChatParticipant(context, core);
  registerBuildrLanguageModelTools(context);

  stepPanel.onApproval((message) => {
    void handleApproval(message, stepPanel);
  });

  context.subscriptions.push(
    vscode.commands.registerCommand("buildr.plan", async () => {
      const goal = await vscode.window.showInputBox({
        title: "Buildr: Plan",
        prompt: "Describe the coding task to plan.",
        ignoreFocusOut: true
      });

      if (!goal) {
        return;
      }

      activeAbortController = new AbortController();
      const configuredCore = createConfiguredCore();
      const modelId = getConfiguredModelId();
      const contextSummary = await createWorkspaceContextSummary(goal);
      const planOptions = {
        goal,
        modelId,
        signal: activeAbortController.signal
      };
      const result = await configuredCore.createPlanFromModel(contextSummary === undefined ? planOptions : {
        ...planOptions,
        contextSummary
      });
      currentPlan = result.plan;
      events = [];
      if (result.warnings.length > 0) {
        events.push({
          id: `plan:fallback:${Date.now()}`,
          title: "Create model-backed plan",
          status: "completed",
          tool: "model_plan",
          summary: `Using fallback plan for ${goal}.`,
          warnings: result.warnings
        });
      } else {
        events.push({
          id: `plan:model:${Date.now()}`,
          title: "Create model-backed plan",
          status: "completed",
          tool: "model_plan",
          summary: `Created plan with ${configuredCore.model.displayName} model ${modelId}.`,
          warnings: []
        });
      }
      pendingApproval = undefined;
      queuedVerificationCommand = undefined;
      renderCurrentState(stepPanel);
      vscode.window.showInformationMessage(`Buildr created a ${currentPlan.steps.length}-step plan (${result.source}).`);
    }),
    vscode.commands.registerCommand("buildr.runApprovedPlan", async () => {
      try {
        requireTrustedWorkspace(vscode.workspace.isTrusted);
      } catch (error) {
        vscode.window.showWarningMessage(error instanceof Error ? error.message : "Buildr execution is blocked.");
        return;
      }

      if (currentPlan === undefined) {
        vscode.window.showWarningMessage("Create a Buildr plan before running approved steps.");
        return;
      }

      activeAbortController = new AbortController();
      await runPhase1A(stepPanel);
    }),
    vscode.commands.registerCommand("buildr.configureModel", async () => {
      const config = vscode.workspace.getConfiguration("buildr.model");
      const provider = await vscode.window.showQuickPick([
        {
          label: "Ollama",
          value: "ollama",
          description: "Uses /api/chat, usually http://127.0.0.1:11434"
        },
        {
          label: "LM Studio",
          value: "lmstudio-openai",
          description: "Uses OpenAI-compatible /v1/chat/completions, usually http://127.0.0.1:1234"
        },
        {
          label: "OpenAI-compatible",
          value: "openai-compatible",
          description: "Uses OpenAI-compatible /v1/chat/completions"
        }
      ], {
        title: "Buildr: Model Provider",
        placeHolder: `Current: ${config.get<string>("provider", "ollama")}`
      });
      if (provider === undefined) {
        return;
      }

      await config.update("provider", provider.value, vscode.ConfigurationTarget.Workspace);

      const urlKey = provider.value === "ollama" ? "ollamaBaseUrl" : "lmStudioBaseUrl";
      const defaultUrl = provider.value === "ollama" ? "http://127.0.0.1:11434" : "http://127.0.0.1:1234";
      const currentUrl = config.get<string>(urlKey, defaultUrl);
      const nextUrl = await vscode.window.showInputBox({
        title: `Buildr: Configure ${provider.label} Endpoint`,
        prompt: provider.value === "ollama"
          ? "Base URL only. Example: http://127.0.0.1:11434"
          : "Base URL only, without /v1. Example: http://127.0.0.1:1234",
        value: currentUrl,
        ignoreFocusOut: true
      });

      if (nextUrl) {
        await config.update(urlKey, stripOpenAiVersionSuffix(nextUrl), vscode.ConfigurationTarget.Workspace);
      }

      const modelAdapter = BuildrCore.createModelAdapter({
        provider: parseProvider(provider.value),
        baseUrl: stripOpenAiVersionSuffix(nextUrl ?? currentUrl)
      });
      const modelId = await selectModelId(modelAdapter, provider.label, config.get<string>("modelId", "qwen2.5-coder"));
      if (modelId === undefined) {
        return;
      }
      await config.update("modelId", modelId, vscode.ConfigurationTarget.Workspace);

      const secret = await vscode.window.showInputBox({
        title: "Buildr: Optional Provider Secret",
        prompt: "Optional API key for cloud/OpenAI-compatible providers. Leave blank to keep existing secret.",
        password: true,
        ignoreFocusOut: true
      });
      if (secret !== undefined && secret.length > 0) {
        await secretStore.storeProviderSecret("openaiCompatible", secret);
        vscode.window.showInformationMessage("Buildr stored provider secret in VS Code SecretStorage.");
      }
      vscode.window.showInformationMessage(`Buildr model set to ${provider.label}.`);
    }),
    vscode.commands.registerCommand("buildr.openSettings", openBuildrSettings),
    vscode.commands.registerCommand("buildr.indexWorkspace", async () => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (root === undefined) {
        vscode.window.showWarningMessage("Open a workspace folder before indexing.");
        return;
      }
      const index = await buildWorkspaceIndex(root);
      vscode.window.showInformationMessage(`Buildr indexed ${index.files.length} file(s).`);
    }),
    vscode.commands.registerCommand("buildr.mcpList", showMcpList),
    vscode.commands.registerCommand("buildr.doctor", showMcpDoctor),
    vscode.commands.registerCommand("buildr.debug", runDebugFromInput),
    vscode.commands.registerCommand("buildr.stop", () => {
      activeAbortController?.abort();
      activeAbortController = undefined;
      events.push({
        id: `cancelled:${Date.now()}`,
        title: "Stop requested",
        status: "blocked",
        summary: "Buildr cancelled the active operation and will not continue queued work.",
        warnings: []
      });
      renderCurrentState(stepPanel, createFinalReportSummary());
      vscode.window.showInformationMessage("Buildr stopped the active operation.");
    })
  );
}

function createConfiguredCore(): BuildrCore {
  const modelConfig = vscode.workspace.getConfiguration("buildr.model");
  const provider = modelConfig.get<string>("provider", "ollama");
  const baseUrl = provider === "lmstudio-openai" || provider === "lmstudio-native" || provider === "openai-compatible"
    ? modelConfig.get<string>("lmStudioBaseUrl", "http://127.0.0.1:1234")
    : modelConfig.get<string>("ollamaBaseUrl", "http://127.0.0.1:11434");
  const model = BuildrCore.createModelAdapter({
    provider: parseProvider(provider),
    baseUrl
  });
  return new BuildrCore({ model });
}

function getConfiguredModelId(): string {
  const modelConfig = vscode.workspace.getConfiguration("buildr.model");
  return modelConfig.get<string>("modelId", "qwen2.5-coder");
}

function parseProvider(value: string): ProviderId {
  if (value === "ollama" || value === "lmstudio-openai" || value === "lmstudio-native" || value === "openai-compatible") {
    return value;
  }
  return "ollama";
}

function stripOpenAiVersionSuffix(value: string): string {
  return value.trim().replace(/\/v1\/?$/u, "");
}

async function selectModelId(adapter: ModelAdapter, providerLabel: string, currentModelId: string): Promise<string | undefined> {
  const models = await fetchProviderModels(adapter, providerLabel);
  if (models.length === 0) {
    return promptForModelId(providerLabel, currentModelId, "No models were returned by the provider. Enter a model id manually.");
  }

  const manualLabel = "Enter model id manually";
  const items: vscode.QuickPickItem[] = [
    ...models.map((model): vscode.QuickPickItem => ({
      label: model.id,
      description: model.provider,
      ...(model.displayName === model.id ? {} : { detail: model.displayName })
    })),
    {
      label: manualLabel,
      description: "Use this if the desired model is not listed.",
      detail: currentModelId
    }
  ];
  const selected = await vscode.window.showQuickPick(items, {
    title: `Buildr: Select ${providerLabel} Model`,
    placeHolder: `Current: ${currentModelId}`,
    matchOnDescription: true,
    matchOnDetail: true,
    ignoreFocusOut: true
  });

  if (selected === undefined) {
    return undefined;
  }
  if (selected.label === manualLabel) {
    return promptForModelId(providerLabel, currentModelId, "Enter the model id to send to the provider.");
  }
  return selected.label;
}

async function fetchProviderModels(adapter: ModelAdapter, providerLabel: string): Promise<ModelInfo[]> {
  if (adapter.listModels === undefined) {
    return [];
  }

  try {
    return await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `Buildr: Fetching ${providerLabel} models`,
      cancellable: false
    }, async () => adapter.listModels?.() ?? []);
  } catch (error) {
    const action = await vscode.window.showWarningMessage(
      `Buildr could not fetch ${providerLabel} models: ${error instanceof Error ? error.message : String(error)}`,
      "Enter Manually"
    );
    return action === "Enter Manually" ? [] : [];
  }
}

async function promptForModelId(providerLabel: string, currentModelId: string, prompt: string): Promise<string | undefined> {
  const value = await vscode.window.showInputBox({
    title: `Buildr: ${providerLabel} Model ID`,
    prompt,
    value: currentModelId,
    ignoreFocusOut: true,
    validateInput: (input) => input.trim().length === 0 ? "Model id is required." : undefined
  });
  return value?.trim();
}

async function createWorkspaceContextSummary(goal: string): Promise<string | undefined> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (root === undefined) {
    return undefined;
  }
  try {
    const index = await buildWorkspaceIndex(root);
    const ranked = rankWorkspaceContext(index, goal, 8);
    const compressed = compressRankedContext(ranked, 3000);
    return compressed.text;
  } catch (error) {
    return `Workspace context indexing failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export function deactivate(): void {
  activeAbortController?.abort();
}

async function runPhase1A(stepPanel: StepPanel): Promise<void> {
  if (currentPlan === undefined) {
    return;
  }

  events.push(readDiagnosticsEvent());

  const searchEvent = await searchWorkspaceEvent(currentPlan.goal);
  if (searchEvent !== undefined) {
    events.push(searchEvent);
  }

  const suggestedTestCommand = await findTaskCommand("test");
  queuedVerificationCommand = await vscode.window.showInputBox({
    title: "Buildr: Optional Verification Command",
    prompt: "Command to run after approved patch, or leave blank to skip.",
    value: suggestedTestCommand ?? "pnpm test",
    ignoreFocusOut: true
  });
  if (queuedVerificationCommand?.trim().length === 0) {
    queuedVerificationCommand = undefined;
  }

  let patchApproval: PendingApproval<TextPatch> | undefined;
  try {
    patchApproval = await createPatchApprovalForActiveEditor(currentPlan.goal);
  } catch (error) {
    events.push({
      id: `patch:model-failed:${Date.now()}`,
      title: "Propose model patch",
      status: "failed",
      tool: "propose_patch",
      summary: error instanceof Error ? error.message : "Model patch proposal failed.",
      warnings: []
    });
  }
  if (patchApproval !== undefined) {
    pendingApproval = patchApproval;
    events.push(eventFromPermissionDecision(patchApproval, "ask"));
    renderCurrentState(stepPanel);
    return;
  }

  if (queuedVerificationCommand !== undefined) {
    pendingApproval = createTerminalApproval(queuedVerificationCommand);
    events.push(eventFromPermissionDecision(pendingApproval, "ask"));
    renderCurrentState(stepPanel);
    return;
  }

  events.push({
    id: "complete:no-actions",
    title: "Complete approved read-only run",
    status: "completed",
    summary: "No active text selection or verification command was provided, so Buildr completed the read-only inspection.",
    warnings: []
  });
  renderCurrentState(stepPanel, createFinalReportSummary());
}

async function handleApproval(message: ApprovalMessage, stepPanel: StepPanel): Promise<void> {
  if (pendingApproval === undefined || message.id !== pendingApproval.id) {
    return;
  }

  const approval = pendingApproval;
  pendingApproval = undefined;

  if (message.decision === "deny") {
    events.push(eventFromPermissionDecision(approval, "deny"));
    renderCurrentState(stepPanel, createFinalReportSummary());
    return;
  }

  events.push(eventFromPermissionDecision(approval, "allow"));

  try {
    if (approval.tool === "apply_patch") {
      await applyApprovedPatch(approval.payload as TextPatch);
      events.push({
        id: `${approval.id}:applied`,
        title: "Apply approved patch",
        status: "completed",
        tool: "apply_patch",
        summary: `Applied patch to ${approval.target ?? "selected file"}.`,
        warnings: [],
        ...(approval.target === undefined ? {} : { target: approval.target })
      });
      addScopeFidelityEvent(approval.target);

      if (queuedVerificationCommand !== undefined) {
        pendingApproval = createTerminalApproval(queuedVerificationCommand);
        events.push(eventFromPermissionDecision(pendingApproval, "ask"));
        renderCurrentState(stepPanel);
        return;
      }
    } else if (approval.tool === "run_terminal") {
      const payload = approval.payload as TerminalApprovalPayload;
      const commandOptions = {
        cwd: payload.cwd,
        ...(activeAbortController?.signal === undefined ? {} : { signal: activeAbortController.signal })
      };
      const evidence = await runVerificationCommand(payload.command, commandOptions);
      events.push({
        id: `${approval.id}:completed`,
        title: "Run approved verification command",
        status: evidence.exitCode === 0 ? "completed" : "failed",
        tool: "run_terminal",
        target: payload.cwd,
        summary: `Command exited with ${evidence.exitCode ?? "unknown"}.`,
        evidence,
        warnings: []
      });
    }
  } catch (error) {
    events.push({
      id: `${approval.id}:failed`,
      title: `${approval.title} failed`,
      status: "failed",
      tool: approval.tool,
      summary: error instanceof Error ? error.message : "Unknown execution failure.",
      warnings: [],
      ...(approval.target === undefined ? {} : { target: approval.target })
    });
  }

  renderCurrentState(stepPanel, createFinalReportSummary());
}

function addScopeFidelityEvent(changedFile: string | undefined): void {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (root === undefined || changedFile === undefined || currentPlan === undefined) {
    return;
  }

  const approvedTargets = currentPlan.steps.flatMap((step) => step.targets);
  const result = checkScopeFidelity({
    workspaceRoot: root,
    approvedTargets,
    changedFiles: [changedFile]
  });

  events.push({
    id: `scope:${Date.now()}`,
    title: "Check scope fidelity",
    status: result.ok ? "completed" : "blocked",
    tool: "check_scope_fidelity",
    target: changedFile,
    summary: result.ok ? "Patch stayed within approved targets." : "Patch touched files outside approved targets.",
    warnings: result.warnings
  });
}

function readDiagnosticsEvent(): ExecutionEvent {
  const diagnostics = readDiagnosticsSummary();
  return {
    id: "inspect:diagnostics",
    title: "Read diagnostics",
    status: "completed",
    tool: "read_diagnostics",
    summary: diagnostics.message,
    evidence: {
      diagnosticsSummary: diagnostics.message
    },
    warnings: []
  };
}

async function searchWorkspaceEvent(goal: string): Promise<ExecutionEvent | undefined> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (root === undefined) {
    return undefined;
  }

  const query = goal.split(/\s+/u).find((part) => part.length > 3) ?? goal;
  const result = await searchCodebaseTool(root, query);
  return {
    id: "inspect:search",
    title: "Search workspace",
    status: result.ok ? "completed" : "failed",
    tool: "search_codebase",
    target: root,
    summary: result.summary,
    warnings: result.warnings
  };
}

async function createPatchApprovalForActiveEditor(goal: string): Promise<PendingApproval<TextPatch> | undefined> {
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined || editor.document.uri.scheme !== "file") {
    return undefined;
  }

  if (!editor.selection.isEmpty) {
    const replacement = await vscode.window.showInputBox({
      title: "Buildr: Replacement Text",
      prompt: "Replacement text for the active selection. Leave blank to ask the configured model for a full-file patch.",
      ignoreFocusOut: true
    });
    if (replacement !== undefined && replacement.length > 0) {
      const before = editor.document.getText();
      const selectionStart = editor.document.offsetAt(editor.selection.start);
      const selectionEnd = editor.document.offsetAt(editor.selection.end);
      const after = `${before.slice(0, selectionStart)}${replacement}${before.slice(selectionEnd)}`;
      const patch = createTextPatch(editor.document.uri.fsPath, before, after);

      return {
        id: `approval:apply_patch:${Date.now()}`,
        title: "Apply active-selection patch",
        tool: "apply_patch",
        target: editor.document.uri.fsPath,
        risk: "medium",
        details: `Replace selected text in ${editor.document.uri.fsPath}.\n\nBefore hash: ${patch.beforeHash}\nAfter hash: ${patch.afterHash}`,
        payload: patch
      };
    }
  }

  const before = editor.document.getText();
  if (before.length > 80_000) {
    vscode.window.showWarningMessage("Buildr skipped model patch proposal because the active file is larger than 80 KB.");
    return undefined;
  }

  const provider = vscode.workspace.getConfiguration("buildr.model").get<string>("provider", "ollama");
  if (provider === "openai-compatible") {
    const approval = await vscode.window.showWarningMessage(
      "Buildr is about to send the active file to the configured OpenAI-compatible endpoint. Continue only if this endpoint is trusted.",
      { modal: true },
      "Send"
    );
    if (approval !== "Send") {
      return undefined;
    }
  }

  const configuredCore = createConfiguredCore();
  const modelId = getConfiguredModelId();
  const contextSummary = await createWorkspaceContextSummary(goal);
  const rewriteOptions = {
    goal,
    modelId,
    path: editor.document.uri.fsPath,
    currentContent: before,
    ...(activeAbortController?.signal === undefined ? {} : { signal: activeAbortController.signal })
  };
  const rewrite = await configuredCore.createFileRewriteFromModel(contextSummary === undefined ? rewriteOptions : {
    ...rewriteOptions,
    contextSummary
  });
  const patch = createTextPatch(editor.document.uri.fsPath, before, rewrite.updatedContent);

  return {
    id: `approval:apply_patch:${Date.now()}`,
    title: "Apply model-proposed file patch",
    tool: "apply_patch",
    target: editor.document.uri.fsPath,
    risk: "high",
    details: `${rewrite.summary}\n\nFile: ${editor.document.uri.fsPath}\nBefore hash: ${patch.beforeHash}\nAfter hash: ${patch.afterHash}\nWarnings: ${rewrite.warnings.join("; ") || "none"}`,
    payload: patch
  };
}

async function applyApprovedPatch(patch: TextPatch): Promise<void> {
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(patch.path));
  const next = applyTextPatch(document.getText(), patch);
  const edit = new vscode.WorkspaceEdit();
  const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
  edit.replace(document.uri, fullRange, next);
  const applied = await vscode.workspace.applyEdit(edit);
  if (!applied) {
    throw new Error(`VS Code rejected the patch for ${patch.path}.`);
  }
  await document.save();
}

function createTerminalApproval(command: string): PendingApproval<TerminalApprovalPayload> {
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  return {
    id: `approval:run_terminal:${Date.now()}`,
    title: "Run verification command",
    tool: "run_terminal",
    target: cwd,
    risk: "medium",
    details: `Command: ${command}\nCwd: ${cwd}\nTimeout: 120000ms`,
    payload: { command, cwd }
  };
}

function renderCurrentState(stepPanel: StepPanel, finalSummary?: string): void {
  if (currentPlan === undefined) {
    return;
  }

  const state = {
    plan: currentPlan,
    events,
    ...(pendingApproval === undefined ? {} : { pendingApproval }),
    ...(finalSummary === undefined ? {} : { finalSummary })
  };
  stepPanel.showState(state);
}

function createFinalReportSummary(): string {
  if (currentPlan === undefined) {
    return createFinalSummary(events);
  }

  const gate = runCompletionGate({
    events,
    rulePacks: loadBuiltInRulePacks(currentPlan.rulePacks),
    ...(queuedVerificationCommand === undefined ? { skippedVerificationReason: "No verification command was provided." } : {})
  });
  return `${createFinalSummary(events)} ${gate.summary}`;
}
