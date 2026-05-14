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
  MainAgentSession,
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
  type TextPatch,
  type TokenBudgetConfig,
  type TokenBudgetState
} from "@buildr/core";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import * as vscode from "vscode";
import { BuildrSecretStore } from "./credentials.js";
import { registerBuildrChatParticipant } from "./native/chatParticipant.js";
import { runDebugFromInput } from "./native/debugMode.js";
import { readDiagnosticsSummary } from "./native/diagnostics.js";
import { registerBuildrLanguageModelTools } from "./native/languageModelTools.js";
import { showMcpDoctor, showMcpList } from "./native/mcpCommands.js";
import { openBuildrSettings } from "./native/settings.js";
import { findTaskCommand } from "./native/tasks.js";
import {
  type ApprovalMessage,
  type BuildrChatMode,
  type ChatMessage,
  type FileSearchMessage,
  type PlanHistoryEntry,
  type PlanStreamState,
  type PromptMessage,
  type SavedAgentSessionSummary,
  StepPanel
} from "./webview/stepPanel.js";

const AGENT_SESSIONS_KEY = "buildr.agentSessions.v1";
const MAX_SAVED_AGENT_SESSIONS = 20;

let activeAbortController: AbortController | undefined;
let currentPlan: BuildrPlan | undefined;
let events: ExecutionEvent[] = [];
let pendingApproval: PendingApproval<TextPatch | TerminalApprovalPayload> | undefined;
let queuedVerificationCommand: string | undefined;
let queuedWriteTargets: PlanWriteTarget[] = [];
let queuedPatchApprovals: PendingApproval<TextPatch>[] = [];
let activeMode: BuildrChatMode = "plan";
let isRunning = false;
let messages: ChatMessage[] = [];
let activePrompt = "";
let lastPlanPrompt = "";
let streamState: PlanStreamState | undefined;
let planHistory: PlanHistoryEntry[] = [];
let currentPlanWarnings: string[] = [];
let tokenBudgetState: TokenBudgetState | undefined;
let currentPlanMentionedFiles: string[] = [];
let finalSummaryState: string | undefined;
let extensionContext: vscode.ExtensionContext | undefined;
let activeSessionId = "";
let savedAgentSessions: PersistedAgentSession[] = [];

interface TerminalApprovalPayload {
  command: string;
  cwd: string;
}

interface PlanWriteTarget {
  path: string;
  title: string;
}

interface WorkspaceContextSummary {
  text: string;
  includedFiles: string[];
  indexedFileCount: number;
  omittedCount: number;
  warnings: string[];
}

interface PersistedAgentSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  state: PersistedAgentSessionState;
}

interface PersistedAgentSessionState {
  currentPlan?: BuildrPlan;
  events: ExecutionEvent[];
  pendingApproval?: PendingApproval<TextPatch | TerminalApprovalPayload>;
  queuedVerificationCommand?: string;
  queuedWriteTargets: PlanWriteTarget[];
  queuedPatchApprovals: Array<PendingApproval<TextPatch>>;
  activeMode: BuildrChatMode;
  messages: ChatMessage[];
  activePrompt: string;
  lastPlanPrompt: string;
  streamState?: PlanStreamState;
  planHistory: PlanHistoryEntry[];
  currentPlanWarnings: string[];
  tokenBudgetState?: TokenBudgetState;
  currentPlanMentionedFiles: string[];
  finalSummary?: string;
}

function loadSavedAgentSessions(context: vscode.ExtensionContext): PersistedAgentSession[] {
  return (context.workspaceState.get<PersistedAgentSession[]>(AGENT_SESSIONS_KEY, []) ?? [])
    .filter(isPersistedAgentSession)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, MAX_SAVED_AGENT_SESSIONS);
}

function createBlankAgentSession(): void {
  activeSessionId = createAgentSessionId();
  resetAgentState();
}

function createNewAgentSession(stepPanel: StepPanel): void {
  if (isRunning) {
    vscode.window.showWarningMessage("Stop the active Buildr operation before opening a different agent.");
    return;
  }
  persistActiveAgentSession();
  activeSessionId = createAgentSessionId();
  resetAgentState();
  persistActiveAgentSession();
  renderCurrentState(stepPanel);
}

function openAgentSession(id: string, stepPanel: StepPanel): void {
  if (isRunning) {
    vscode.window.showWarningMessage("Stop the active Buildr operation before opening a saved agent.");
    renderCurrentState(stepPanel);
    return;
  }
  if (id === activeSessionId) {
    return;
  }
  const session = savedAgentSessions.find((candidate) => candidate.id === id);
  if (session === undefined) {
    vscode.window.showWarningMessage("Buildr could not find that saved agent.");
    renderCurrentState(stepPanel);
    return;
  }
  persistActiveAgentSession();
  restoreAgentSession(session);
  persistActiveAgentSession();
  renderCurrentState(stepPanel);
}

function persistActiveAgentSession(): void {
  const context = extensionContext;
  if (context === undefined || activeSessionId.length === 0) {
    return;
  }
  const now = new Date().toISOString();
  const existing = savedAgentSessions.find((session) => session.id === activeSessionId);
  const session = {
    id: activeSessionId,
    title: getActiveSessionTitle(),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    state: snapshotAgentState()
  };
  savedAgentSessions = [
    session,
    ...savedAgentSessions.filter((candidate) => candidate.id !== activeSessionId)
  ].slice(0, MAX_SAVED_AGENT_SESSIONS);
  void context.workspaceState.update(AGENT_SESSIONS_KEY, savedAgentSessions);
}

function restoreAgentSession(session: PersistedAgentSession): void {
  activeSessionId = session.id;
  currentPlan = session.state.currentPlan;
  events = [...session.state.events];
  pendingApproval = session.state.pendingApproval;
  queuedVerificationCommand = session.state.queuedVerificationCommand;
  queuedWriteTargets = [...session.state.queuedWriteTargets];
  queuedPatchApprovals = [...session.state.queuedPatchApprovals];
  activeMode = session.state.activeMode;
  isRunning = false;
  messages = [...session.state.messages];
  activePrompt = session.state.activePrompt;
  lastPlanPrompt = session.state.lastPlanPrompt;
  streamState = session.state.streamState === undefined ? undefined : { ...session.state.streamState, active: false };
  planHistory = [...session.state.planHistory];
  currentPlanWarnings = [...session.state.currentPlanWarnings];
  tokenBudgetState = session.state.tokenBudgetState;
  currentPlanMentionedFiles = [...session.state.currentPlanMentionedFiles];
  finalSummaryState = session.state.finalSummary;
  activeAbortController = undefined;
}

function resetAgentState(): void {
  activeAbortController = undefined;
  currentPlan = undefined;
  events = [];
  pendingApproval = undefined;
  queuedVerificationCommand = undefined;
  queuedWriteTargets = [];
  queuedPatchApprovals = [];
  activeMode = "plan";
  isRunning = false;
  messages = [];
  activePrompt = "";
  lastPlanPrompt = "";
  streamState = undefined;
  planHistory = [];
  currentPlanWarnings = [];
  tokenBudgetState = undefined;
  currentPlanMentionedFiles = [];
  finalSummaryState = undefined;
}

function snapshotAgentState(): PersistedAgentSessionState {
  return {
    events,
    queuedWriteTargets,
    queuedPatchApprovals,
    activeMode,
    messages,
    activePrompt,
    lastPlanPrompt,
    planHistory,
    currentPlanWarnings,
    currentPlanMentionedFiles,
    ...(currentPlan === undefined ? {} : { currentPlan }),
    ...(pendingApproval === undefined ? {} : { pendingApproval }),
    ...(queuedVerificationCommand === undefined ? {} : { queuedVerificationCommand }),
    ...(streamState === undefined ? {} : { streamState: { ...streamState, active: false } }),
    ...(tokenBudgetState === undefined ? {} : { tokenBudgetState }),
    ...(finalSummaryState === undefined ? {} : { finalSummary: finalSummaryState })
  };
}

function getActiveSessionTitle(): string {
  const firstUserMessage = messages.find((message) => message.role === "user")?.text.replace(/^(Ask|Plan|Agent|Debug):\s*/u, "").trim();
  const title = currentPlan?.goal ?? firstUserMessage ?? "New agent";
  return title.length > 48 ? `${title.slice(0, 45)}...` : title;
}

function getSessionSummaries(): SavedAgentSessionSummary[] {
  return savedAgentSessions.map((session) => ({
    id: session.id,
    title: session.title,
    createdAt: formatSessionTimestamp(session.createdAt),
    updatedAt: formatSessionTimestamp(session.updatedAt)
  }));
}

function formatSessionTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function createAgentSessionId(): string {
  return `agent:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
}

function isPersistedAgentSession(value: unknown): value is PersistedAgentSession {
  return typeof value === "object"
    && value !== null
    && typeof (value as { id?: unknown }).id === "string"
    && typeof (value as { title?: unknown }).title === "string"
    && typeof (value as { createdAt?: unknown }).createdAt === "string"
    && typeof (value as { updatedAt?: unknown }).updatedAt === "string"
    && typeof (value as { state?: unknown }).state === "object"
    && (value as { state?: unknown }).state !== null;
}

export function activate(context: vscode.ExtensionContext): void {
  extensionContext = context;
  savedAgentSessions = loadSavedAgentSessions(context);
  if (savedAgentSessions.length > 0) {
    restoreAgentSession(savedAgentSessions[0]!);
  } else {
    createBlankAgentSession();
  }

  const core = new BuildrCore();
  const stepPanel = new StepPanel(context.extensionUri);
  const secretStore = new BuildrSecretStore(context.secrets);
  registerBuildrChatParticipant(context, core);
  registerBuildrLanguageModelTools(context);

  stepPanel.onApproval((message) => {
    void handleApproval(message, stepPanel);
  });
  stepPanel.onPrompt((message) => {
    void handlePrompt(message, stepPanel);
  });
  stepPanel.onFileSearch((message) => {
    void handleFileSearch(message, stepPanel);
  });
  stepPanel.onOpenSession((id) => {
    openAgentSession(id, stepPanel);
  });
  stepPanel.onNewSession(() => {
    createNewAgentSession(stepPanel);
  });
  stepPanel.onRunPlan(() => {
    void runCurrentPlanFromUi(stepPanel);
  });
  stepPanel.onChangePlan(() => {
    changeCurrentPlan(stepPanel);
  });
  stepPanel.onStop(() => {
    stopActiveOperation(stepPanel);
  });
  stepPanel.onDispose(() => {
    persistActiveAgentSession();
  });

  context.subscriptions.push(
    vscode.commands.registerCommand("buildr.openChat", () => {
      createNewAgentSession(stepPanel);
    }),
    vscode.commands.registerCommand("buildr.plan", async () => {
      const goal = await vscode.window.showInputBox({
        title: "Buildr: Plan",
        prompt: "Describe the coding task to plan.",
        ignoreFocusOut: true
      });

      if (!goal) {
        return;
      }

      activeMode = "plan";
      await createPlanFromGoal(goal, [], stepPanel);
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

      activeMode = "agent";
      isRunning = true;
      renderCurrentState(stepPanel);
      activeAbortController = new AbortController();
      try {
        await runPhase1A(stepPanel);
      } finally {
        isRunning = false;
        renderCurrentState(stepPanel);
      }
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
      stopActiveOperation(stepPanel);
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

async function handlePrompt(message: PromptMessage, stepPanel: StepPanel): Promise<void> {
  const prompt = message.prompt.trim();
  if (prompt.length === 0 || isRunning) {
    return;
  }

  activeMode = message.mode;
  activePrompt = prompt;
  finalSummaryState = undefined;
  messages.push({
    role: "user",
    text: `${modeLabel(message.mode)}: ${prompt}`
  });
  renderCurrentState(stepPanel);

  if (message.mode === "debug") {
    messages.push({
      role: "assistant",
      text: "Opening Debug Mode input."
    });
    renderCurrentState(stepPanel);
    await runDebugFromInput();
    return;
  }

  if (message.mode === "ask") {
    isRunning = true;
    renderCurrentState(stepPanel);
    activeAbortController = new AbortController();
    try {
      await answerRepoQuestion(prompt, message.fileMentions, stepPanel);
    } finally {
      isRunning = false;
      activeAbortController = undefined;
      renderCurrentState(stepPanel);
    }
    return;
  }

  const result = await createPlanFromGoal(prompt, message.fileMentions, stepPanel);
  if (message.mode !== "agent" || result === undefined) {
    return;
  }

  try {
    requireTrustedWorkspace(vscode.workspace.isTrusted);
  } catch (error) {
    vscode.window.showWarningMessage(error instanceof Error ? error.message : "Buildr execution is blocked.");
    messages.push({
      role: "assistant",
      text: error instanceof Error ? error.message : "Buildr execution is blocked."
    });
    renderCurrentState(stepPanel);
    return;
  }

  isRunning = true;
  renderCurrentState(stepPanel);
  activeAbortController = new AbortController();
  try {
    await runPhase1A(stepPanel);
  } finally {
    isRunning = false;
    renderCurrentState(stepPanel);
  }
}

async function runCurrentPlanFromUi(stepPanel: StepPanel): Promise<void> {
  if (isRunning || pendingApproval !== undefined) {
    return;
  }

  try {
    requireTrustedWorkspace(vscode.workspace.isTrusted);
  } catch (error) {
    vscode.window.showWarningMessage(error instanceof Error ? error.message : "Buildr execution is blocked.");
    messages.push({
      role: "assistant",
      text: error instanceof Error ? error.message : "Buildr execution is blocked."
    });
    renderCurrentState(stepPanel);
    return;
  }

  if (currentPlan === undefined) {
    vscode.window.showWarningMessage("Create a Buildr plan before running approved steps.");
    return;
  }

  activeMode = "agent";
  isRunning = true;
  activeAbortController = new AbortController();
  renderCurrentState(stepPanel);
  try {
    await runPhase1A(stepPanel);
  } finally {
    isRunning = false;
    renderCurrentState(stepPanel);
  }
}

function changeCurrentPlan(stepPanel: StepPanel): void {
  if (isRunning) {
    return;
  }
  activeMode = "plan";
  activePrompt = lastPlanPrompt || activePrompt;
  streamState = undefined;
  renderCurrentState(stepPanel);
  stepPanel.postEditPrompt(activePrompt);
}

async function createPlanFromGoal(goal: string, fileMentions: string[], stepPanel: StepPanel): Promise<BuildrPlan | undefined> {
  isRunning = true;
  activeAbortController = new AbortController();
  archiveCurrentPlan();
  activePrompt = goal;
  lastPlanPrompt = goal;
  finalSummaryState = undefined;
  streamState = {
    active: true,
    status: "Indexing workspace context.",
    raw: ""
  };
  renderCurrentState(stepPanel);

  try {
    events = [];
    const resolvedMentions = resolveFileMentions(fileMentions);
    currentPlanMentionedFiles = resolvedMentions;
    const configuredCore = createConfiguredCore();
    const modelId = getConfiguredModelId();
    const context = await createWorkspaceContextSummary(goal, resolvedMentions);
    events.push(createContextInspectionEvent(context, "Plan repo context"));
    streamState.status = "Asking model for a plan.";
    renderCurrentState(stepPanel);
    stepPanel.postStreamStart(streamState.status);
    const planOptions = {
      goal: appendMentionHint(goal, resolvedMentions),
      modelId,
      signal: activeAbortController.signal,
      onDelta: (content: string) => {
        if (streamState !== undefined) {
          streamState.raw += content;
        }
        stepPanel.postStreamDelta(content);
      }
    };
    const result = await configuredCore.createPlanFromModel(context.text.length === 0 ? planOptions : {
      ...planOptions,
      contextSummary: context.text
    });
    if (streamState !== undefined) {
      streamState.active = false;
      streamState.status = result.source === "fallback" ? "Model plan failed; fallback plan is shown." : "Validated model plan.";
    }
    stepPanel.postStreamComplete(streamState?.status ?? "Planning finished.");
    currentPlan = result.plan;
    currentPlanWarnings = result.warnings;
    queuedWriteTargets = [];
    pendingApproval = undefined;
    queuedVerificationCommand = undefined;
    queuedPatchApprovals = [];
    tokenBudgetState = undefined;

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

    messages.push({
      role: "assistant",
      text: `Created a ${currentPlan.steps.length}-step plan.`
    });
    renderCurrentState(stepPanel);
    vscode.window.showInformationMessage(`Buildr created a ${currentPlan.steps.length}-step plan (${result.source}).`);
    return currentPlan;
  } catch (error) {
    const summary = error instanceof Error ? error.message : "Buildr could not create a plan.";
    if (streamState !== undefined) {
      streamState.active = false;
      streamState.status = summary;
    }
    stepPanel.postStreamError(summary);
    events.push({
      id: `plan:error:${Date.now()}`,
      title: "Create model-backed plan",
      status: "failed",
      tool: "model_plan",
      summary,
      warnings: []
    });
    messages.push({
      role: "assistant",
      text: summary
    });
    renderCurrentState(stepPanel);
    vscode.window.showErrorMessage(summary);
    return undefined;
  } finally {
    isRunning = false;
    activeAbortController = undefined;
    renderCurrentState(stepPanel);
  }
}

async function handleFileSearch(message: FileSearchMessage, stepPanel: StepPanel): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0];
  if (root === undefined) {
    stepPanel.postFileSearchResults([]);
    return;
  }

  const query = normalizeWorkspacePath(message.query.trim());
  const files = await vscode.workspace.findFiles(
    new vscode.RelativePattern(root, "**/*"),
    "{**/.git/**,**/node_modules/**,**/dist/**,**/out/**,**/coverage/**,**/.pnpm-store/**}",
    300
  );
  const scored = files
    .map((uri) => normalizeWorkspacePath(relative(root.uri.fsPath, uri.fsPath)))
    .filter((path) => query.length === 0 || path.toLowerCase().includes(query.toLowerCase()))
    .sort((left, right) => scoreFileMention(left, query) - scoreFileMention(right, query) || left.localeCompare(right))
    .slice(0, 12);
  stepPanel.postFileSearchResults(scored);
}

async function answerRepoQuestion(question: string, fileMentions: string[], stepPanel: StepPanel): Promise<void> {
  const resolvedMentions = resolveFileMentions(fileMentions);
  const context = await createWorkspaceContextSummary(question, resolvedMentions);
  events.push(createContextInspectionEvent(context, "Ask repo context"));
  renderCurrentState(stepPanel);

  const configuredCore = createConfiguredCore();
  const modelId = getConfiguredModelId();
  let answer = "";
  for await (const delta of configuredCore.model.chat({
    model: modelId,
    temperature: 0.1,
    messages: createAskMessages(question, context)
  }, activeAbortController?.signal === undefined ? {} : { signal: activeAbortController.signal })) {
    if (delta.type === "text" && delta.content !== undefined) {
      answer += delta.content;
    }
  }

  const consulted = context.includedFiles.length === 0
    ? "No repo files were available from the context index."
    : `Consulted files: ${context.includedFiles.join(", ")}`;
  messages.push({
    role: "assistant",
    text: [answer.trim() || "I could not produce an answer.", "", consulted].join("\n")
  });
  renderCurrentState(stepPanel);
}

function createAskMessages(question: string, context: WorkspaceContextSummary): Array<{ role: "system" | "user"; content: string }> {
  return [
    {
      role: "system",
      content: [
        "You are Buildr Ask Mode.",
        "Answer questions about the user's repository using only the supplied workspace context.",
        "If the context is insufficient, say what is missing and name the files that would help.",
        "Do not create a plan, propose patches, or ask for command approval."
      ].join("\n")
    },
    {
      role: "user",
      content: [
        `Question: ${question}`,
        "",
        "Workspace context:",
        context.text.length === 0 ? "No workspace context was available." : context.text
      ].join("\n")
    }
  ];
}

async function createWorkspaceContextSummary(goal: string, mentionedFiles: string[] = []): Promise<WorkspaceContextSummary> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (root === undefined) {
    return {
      text: "",
      includedFiles: [],
      indexedFileCount: 0,
      omittedCount: 0,
      warnings: ["No workspace folder is open."]
    };
  }
  try {
    const index = await buildWorkspaceIndex(root);
    const ranked = rankWorkspaceContext(index, goal, 8);
    const mentioned = await loadMentionedFileContext(root, mentionedFiles, index.files);
    const compressed = compressRankedContext(ranked, 3000);
    const mentionSummary = mentioned.length === 0
      ? ""
      : [
        "User-mentioned files:",
        ...mentioned.map((file) => `- ${file.relativePath}:\n${file.content}`)
      ].join("\n");
    return {
      text: [mentionSummary, compressed.text].filter((part) => part.trim().length > 0).join("\n\n"),
      includedFiles: [...new Set([...mentioned.map((file) => file.relativePath), ...compressed.includedFiles])],
      indexedFileCount: index.files.length,
      omittedCount: compressed.omittedCount,
      warnings: []
    };
  } catch (error) {
    return {
      text: `Workspace context indexing failed: ${error instanceof Error ? error.message : String(error)}`,
      includedFiles: [],
      indexedFileCount: 0,
      omittedCount: 0,
      warnings: [`Workspace context indexing failed: ${error instanceof Error ? error.message : String(error)}`]
    };
  }
}

async function loadMentionedFileContext(
  root: string,
  mentionedFiles: string[],
  indexedFiles: Array<{ relativePath: string; summary: string }>
): Promise<Array<{ relativePath: string; content: string }>> {
  const indexed = new Map(indexedFiles.map((file) => [file.relativePath, file.summary]));
  const loaded: Array<{ relativePath: string; content: string }> = [];

  for (const relativePath of mentionedFiles) {
    const absolute = resolve(root, relativePath);
    if (!isWorkspaceRelativePath(root, absolute)) {
      continue;
    }

    const content = await readTextFileIfExists(absolute);
    if (content.length > 0) {
      loaded.push({
        relativePath,
        content: summarizeMentionedFile(content)
      });
      continue;
    }

    const indexedSummary = indexed.get(relativePath);
    if (indexedSummary !== undefined) {
      loaded.push({
        relativePath,
        content: indexedSummary
      });
    }
  }

  return loaded;
}

function summarizeMentionedFile(content: string): string {
  const maxChars = 4000;
  if (content.length <= maxChars) {
    return content;
  }
  return `${content.slice(0, maxChars)}\n...[${content.length - maxChars} chars omitted]`;
}

function createContextInspectionEvent(context: WorkspaceContextSummary, title: string): ExecutionEvent {
  const files = context.includedFiles.length === 0 ? "none" : context.includedFiles.join(", ");
  return {
    id: `context:${Date.now()}`,
    title,
    status: context.warnings.length === 0 ? "completed" : "failed",
    tool: "workspace_context",
    summary: `Indexed ${context.indexedFileCount} file(s); consulted ${context.includedFiles.length} file(s); omitted ${context.omittedCount}.`,
    evidence: {
      diagnosticsSummary: `Consulted files: ${files}`
    },
    warnings: context.warnings
  };
}

function createSubAgentSourceContext(context: WorkspaceContextSummary, target: PlanWriteTarget): string {
  return [
    `Target assignment: ${target.title}`,
    `Target file: ${target.path}`,
    "",
    "Source and relevant workspace excerpts:",
    summarizeForSubAgent(context.text)
  ].join("\n");
}

function summarizeForSubAgent(text: string): string {
  const maxChars = 5000;
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n...[${text.length - maxChars} chars omitted]`;
}

function resolveFileMentions(fileMentions: string[]): string[] {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (root === undefined) {
    return [];
  }

  const seen = new Set<string>();
  const resolved: string[] = [];
  for (const mention of fileMentions) {
    const normalized = normalizeWorkspacePath(stripMentionPunctuation(mention));
    const absolute = resolve(root, normalized);
    const relativePath = normalizeWorkspacePath(relative(root, absolute));
    if (relativePath.length === 0 || relativePath.startsWith("../") || relativePath === ".." || seen.has(relativePath)) {
      continue;
    }
    seen.add(relativePath);
    resolved.push(relativePath);
  }
  return resolved;
}

function appendMentionHint(goal: string, mentionedFiles: string[]): string {
  if (mentionedFiles.length === 0) {
    return goal;
  }
  return [
    goal,
    "",
    "User-mentioned files:",
    ...mentionedFiles.map((file) => `@${file}`)
  ].join("\n");
}

function normalizeWorkspacePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.?\//u, "");
}

function stripMentionPunctuation(mention: string): string {
  return mention.replace(/[),.;:!?]+$/u, "");
}

function isWorkspaceRelativePath(root: string, absolutePath: string): boolean {
  const relativePath = relative(root, absolutePath);
  return relativePath.length > 0 && !relativePath.startsWith("..") && relativePath !== "..";
}

function scoreFileMention(path: string, query: string): number {
  if (query.length === 0) {
    return path.split("/").length;
  }
  const lowerPath = path.toLowerCase();
  const lowerQuery = query.toLowerCase();
  if (lowerPath === lowerQuery) {
    return 0;
  }
  if (lowerPath.endsWith(`/${lowerQuery}`) || lowerPath.startsWith(lowerQuery)) {
    return 1;
  }
  if (lowerPath.includes(`/${lowerQuery}`)) {
    return 2;
  }
  return 3;
}

function modeLabel(mode: BuildrChatMode): string {
  switch (mode) {
    case "ask":
      return "Ask";
    case "agent":
      return "Agent";
    case "debug":
      return "Debug";
    case "plan":
      return "Plan";
  }
}

function stopActiveOperation(stepPanel: StepPanel): void {
  activeAbortController?.abort();
  activeAbortController = undefined;
  isRunning = false;
  queuedWriteTargets = [];
  queuedPatchApprovals = [];
  events.push({
    id: `cancelled:${Date.now()}`,
    title: "Stop requested",
    status: "blocked",
    summary: "Buildr cancelled the active operation and will not continue queued work.",
    warnings: []
  });
  messages.push({
    role: "system",
    text: "Stop requested."
  });
  renderCurrentState(stepPanel, currentPlan === undefined ? undefined : createFinalReportSummary());
  vscode.window.showInformationMessage("Buildr stopped the active operation.");
}

function archiveCurrentPlan(): void {
  if (currentPlan === undefined) {
    return;
  }

  planHistory.push({
    id: `plan:${Date.now()}:${planHistory.length}`,
    prompt: lastPlanPrompt || currentPlan.goal,
    plan: currentPlan,
    ...(streamState === undefined ? {} : { stream: { ...streamState } }),
    createdAt: new Date().toLocaleString(),
    warnings: currentPlanWarnings
  });
  currentPlan = undefined;
  currentPlanWarnings = [];
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

  queuedVerificationCommand = await selectVerificationCommand(currentPlan);

  queuedWriteTargets = collectPlanWriteTargets(currentPlan);
  if (queuedWriteTargets.length > 0) {
    await queueParallelPlanPatchApprovals(stepPanel);
    return;
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
    renderCurrentState(stepPanel, await queueVerificationApproval() === "skipped" ? createFinalReportSummary() : undefined);
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

      if (queuedPatchApprovals.length > 0) {
        pendingApproval = queuedPatchApprovals.shift();
        if (pendingApproval !== undefined) {
          events.push(eventFromPermissionDecision(pendingApproval, "ask"));
        }
        renderCurrentState(stepPanel);
        return;
      }

      if (queuedVerificationCommand !== undefined) {
        renderCurrentState(stepPanel, await queueVerificationApproval() === "skipped" ? createFinalReportSummary() : undefined);
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
  const context = await createWorkspaceContextSummary(goal);
  const rewriteOptions = {
    goal,
    modelId,
    path: editor.document.uri.fsPath,
    currentContent: before,
    ...(activeAbortController?.signal === undefined ? {} : { signal: activeAbortController.signal })
  };
  const rewrite = await configuredCore.createFileRewriteFromModel(context.text.length === 0 ? rewriteOptions : {
    ...rewriteOptions,
    contextSummary: context.text
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

async function queueParallelPlanPatchApprovals(stepPanel: StepPanel): Promise<void> {
  if (queuedWriteTargets.length === 0 || currentPlan === undefined) {
    if (queuedVerificationCommand !== undefined) {
      renderCurrentState(stepPanel, await queueVerificationApproval() === "skipped" ? createFinalReportSummary() : undefined);
      return;
    }
    renderCurrentState(stepPanel, createFinalReportSummary());
    return;
  }

  const targets = queuedWriteTargets.splice(0);
  let finalSummary: string | undefined;
  try {
    const approvals = await createPatchApprovalsForPlanTargets(currentPlan.goal, targets, stepPanel);
    queuedPatchApprovals = approvals;
    pendingApproval = queuedPatchApprovals.shift();
    if (pendingApproval !== undefined) {
      events.push(eventFromPermissionDecision(pendingApproval, "ask"));
    } else if (queuedVerificationCommand !== undefined) {
      if (await queueVerificationApproval() === "skipped") {
        finalSummary = createFinalReportSummary();
      }
    }
  } catch (error) {
    events.push({
      id: `patch:${Date.now()}:failed`,
      title: "Propose parallel sub-agent patches",
      status: "failed",
      tool: "propose_patch",
      summary: error instanceof Error ? error.message : "Model patch proposal failed.",
      warnings: []
    });
  }

  renderCurrentState(stepPanel, finalSummary);
}

async function createPatchApprovalsForPlanTargets(goal: string, targets: PlanWriteTarget[], stepPanel: StepPanel): Promise<Array<PendingApproval<TextPatch>>> {
  const configuredCore = createConfiguredCore();
  const modelId = getConfiguredModelId();
  const context = await createWorkspaceContextSummary(goal, currentPlanMentionedFiles);
  const tasks = await Promise.all(targets.map(async (target, index) => ({
    id: `patch_${index + 1}`,
    title: target.title,
    path: target.path,
    currentContent: await readTextFileIfExists(target.path),
    ...(context.text.length === 0 ? {} : { contextSummary: createSubAgentSourceContext(context, target) }),
    ...(context.includedFiles.length === 0 ? {} : { consultedFiles: context.includedFiles })
  })));
  const sessionOptions = {
    core: configuredCore,
    modelId,
    goal,
    transcript: messages.map((message) => ({ role: message.role, text: message.text })),
    tasks,
    maxParallelSubAgents: getMaxParallelSubAgents(),
    tokenBudget: getTokenBudgetConfig(),
    onTokenBudgetUpdate: (state: TokenBudgetState) => {
      tokenBudgetState = state;
      renderCurrentState(stepPanel);
    },
    ...(activeAbortController?.signal === undefined ? {} : { signal: activeAbortController.signal })
  };
  const session = new MainAgentSession(sessionOptions);
  const report = await session.run();
  tokenBudgetState = report.tokenBudget;
  events.push({
    id: `agents:${Date.now()}`,
    title: "Run parallel sub-agents",
    status: report.patchProposals.length > 0 ? "completed" : "failed",
    tool: "main_agent",
    summary: `Ran ${report.subAgents.length} sub-agent(s); received ${report.patchProposals.length} patch proposal(s). Tokens: ${report.tokenBudget.totalTokens}/${report.tokenBudget.hardTokenCap}, estimated cost $${report.tokenBudget.estimatedCostUsd.toFixed(6)}.`,
    warnings: report.warnings
  });

  return report.subAgents.flatMap((result) => {
    if (result.patch === undefined) {
      return [];
    }
    return [{
      id: `approval:apply_patch:${Date.now()}:${result.id}`,
      title: `Apply ${result.title}`,
      tool: "apply_patch",
      target: result.patch.path,
      risk: "high" as const,
      details: [
        result.summary,
        "",
        `Sub-agent: ${result.id}`,
        `File: ${result.patch.path}`,
        `Before hash: ${result.patch.beforeHash}`,
        `After hash: ${result.patch.afterHash}`,
        `Warnings: ${result.warnings.join("; ") || "none"}`
      ].join("\n"),
      payload: result.patch
    }];
  });
}

async function createPatchApprovalForPlanTarget(goal: string, target: PlanWriteTarget): Promise<PendingApproval<TextPatch>> {
  const before = await readTextFileIfExists(target.path);
  if (before.length > 80_000) {
    throw new Error(`Skipped ${target.path} because it is larger than 80 KB.`);
  }

  const configuredCore = createConfiguredCore();
  const modelId = getConfiguredModelId();
  const context = await createWorkspaceContextSummary(`${goal}\nCurrent target: ${target.path}`);
  const rewriteOptions = {
    goal: `${goal}\n\nImplement this plan step: ${target.title}`,
    modelId,
    path: target.path,
    currentContent: before,
    ...(activeAbortController?.signal === undefined ? {} : { signal: activeAbortController.signal })
  };
  const rewrite = await configuredCore.createFileRewriteFromModel(context.text.length === 0 ? rewriteOptions : {
    ...rewriteOptions,
    contextSummary: context.text
  });
  const patch = createTextPatch(target.path, before, rewrite.updatedContent);

  return {
    id: `approval:apply_patch:${Date.now()}`,
    title: `Apply patch for ${target.title}`,
    tool: "apply_patch",
    target: target.path,
    risk: before.length === 0 ? "medium" : "high",
    details: `${rewrite.summary}\n\nFile: ${target.path}\nBefore hash: ${patch.beforeHash}\nAfter hash: ${patch.afterHash}\nWarnings: ${rewrite.warnings.join("; ") || "none"}`,
    payload: patch
  };
}

function collectPlanWriteTargets(plan: BuildrPlan): PlanWriteTarget[] {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (root === undefined) {
    return [];
  }

  const seen = new Set<string>();
  const targets: PlanWriteTarget[] = [];
  for (const step of plan.steps) {
    if (step.kind !== "write") {
      continue;
    }
    for (const target of step.targets) {
      const path = resolvePlanTarget(root, target);
      if (path === undefined || seen.has(path)) {
        continue;
      }
      seen.add(path);
      targets.push({ path, title: step.title });
    }
  }
  return targets;
}

function resolvePlanTarget(root: string, target: string): string | undefined {
  const trimmed = target.trim();
  if (
    trimmed.length === 0 ||
    trimmed === "." ||
    trimmed === "./" ||
    trimmed.includes("${") ||
    trimmed.includes("*") ||
    trimmed.toLowerCase().includes("approved ") ||
    trimmed.endsWith("/")
  ) {
    return undefined;
  }

  const resolved = resolve(root, trimmed);
  const relativePath = relative(root, resolved);
  if (relativePath.startsWith("..") || relativePath === "") {
    return undefined;
  }
  return resolved;
}

async function readTextFileIfExists(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

async function applyApprovedPatch(patch: TextPatch): Promise<void> {
  const current = await readTextFileIfExists(patch.path);
  const next = applyTextPatch(current, patch);
  await mkdir(dirname(patch.path), { recursive: true });
  await writeFile(patch.path, next, "utf8");
}

async function queueVerificationApproval(): Promise<"queued" | "skipped"> {
  if (queuedVerificationCommand === undefined) {
    return "skipped";
  }

  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  const skippedReason = await getVerificationSkipReason(queuedVerificationCommand, cwd);
  if (skippedReason !== undefined) {
    events.push({
      id: `verify:skipped:${Date.now()}`,
      title: "Skip verification command",
      status: "completed",
      tool: "run_terminal",
      target: cwd,
      summary: skippedReason,
      evidence: { skippedReason },
      warnings: [skippedReason]
    });
    queuedVerificationCommand = undefined;
    return "skipped";
  }

  pendingApproval = createTerminalApproval(queuedVerificationCommand);
  events.push(eventFromPermissionDecision(pendingApproval, "ask"));
  return "queued";
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

async function getVerificationSkipReason(command: string, cwd: string): Promise<string | undefined> {
  const file = findNodeCheckFileArgument(command);
  if (file === undefined) {
    return undefined;
  }

  const path = resolve(cwd, file);
  try {
    await access(path);
    return undefined;
  } catch {
    return `Skipped verification because "${command}" references missing file "${file}".`;
  }
}

function findNodeCheckFileArgument(command: string): string | undefined {
  const args = splitShellWords(command);
  const nodeIndex = args.findIndex((arg) => arg === "node" || arg.endsWith("/node"));
  if (nodeIndex === -1) {
    return undefined;
  }

  const checkIndex = args.findIndex((arg, index) => index > nodeIndex && (arg === "--check" || arg === "-c"));
  if (checkIndex === -1) {
    return undefined;
  }

  return args.slice(checkIndex + 1).find((arg) => !arg.startsWith("-"));
}

function splitShellWords(command: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: "'" | "\"" | undefined;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (char === undefined) {
      continue;
    }
    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (/\s/u.test(char)) {
      if (current.length > 0) {
        words.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (current.length > 0) {
    words.push(current);
  }
  return words;
}

async function selectVerificationCommand(plan: BuildrPlan): Promise<string | undefined> {
  const planCommand = plan.verification.commands.find((command) => command.trim().length > 0)?.trim();
  if (planCommand !== undefined) {
    return planCommand;
  }

  const suggestedTestCommand = await findTaskCommand("test");
  const trimmed = suggestedTestCommand?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function renderCurrentState(stepPanel: StepPanel, finalSummary?: string): void {
  if (finalSummary !== undefined) {
    finalSummaryState = finalSummary;
  }
  persistActiveAgentSession();
  const state = {
    events,
    mode: activeMode,
    running: isRunning,
    messages,
    activePrompt,
    planHistory,
    ...(streamState === undefined ? {} : { stream: streamState }),
    ...(tokenBudgetState === undefined ? {} : { tokenBudget: tokenBudgetState }),
    ...(currentPlan === undefined ? {} : { plan: currentPlan }),
    ...(pendingApproval === undefined ? {} : { pendingApproval }),
    ...(finalSummaryState === undefined ? {} : { finalSummary: finalSummaryState }),
    activeSessionId,
    sessions: getSessionSummaries()
  };
  stepPanel.showState(state);
}

function getMaxParallelSubAgents(): number {
  return vscode.workspace.getConfiguration("buildr.agents").get<number>("maxParallelSubAgents", 3);
}

function getTokenBudgetConfig(): TokenBudgetConfig {
  const contextConfig = vscode.workspace.getConfiguration("buildr.context");
  const costConfig = vscode.workspace.getConfiguration("buildr.cost");
  return {
    hardTokenCap: contextConfig.get<number>("hardTokenCap", contextConfig.get<number>("tokenBudget", 32000)),
    warningThresholds: contextConfig.get<number[]>("warningThresholds", [0.7, 0.9]),
    costRate: {
      inputUsdPerMillion: costConfig.get<number>("inputUsdPerMillion", 0),
      outputUsdPerMillion: costConfig.get<number>("outputUsdPerMillion", 0)
    }
  };
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
