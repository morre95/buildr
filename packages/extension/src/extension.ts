import {
  applyTextPatch,
  compactAgentContext,
  createArchitectMessages,
  createCoderMessages,
  buildWorkspaceIndex,
  builtInTools,
  BuildrCore,
  checkScopeFidelity,
  compressRankedContext,
  createReviewerMessages,
  createTesterMessages,
  createFinalSummary,
  createTextPatch,
  createTextPatchFromAgentDiff,
  eventFromPermissionDecision,
  eventFromToolResult,
  formatTextPatchAsGitDiff,
  hashText,
  isPlausibleWorkspacePath,
  loadBuiltInRulePacks,
  MainAgentSession,
  parseAgentEnvelope,
  readFileTool,
  rankWorkspaceContext,
  requireTrustedWorkspace,
  resolveCoderRetryLimit,
  runCompletionGate,
  runVerificationCommand,
  searchCodebaseTool,
  validateArchitectOutput,
  validateCoderOutput,
  validateReviewerOutput,
  validateTesterOutput,
  type AgentFileSnapshot,
  type AgentJsonEnvelope,
  type AgentPlan,
  type AgentPlanTask,
  type AgentRole,
  type AgentTestCase,
  type CoderOutput,
  type BuildrPlan,
  type ChatMessage as CoreChatMessage,
  type ExecutionEvent,
  type ModelAdapter,
  type ModelInfo,
  type PendingApproval,
  type ProviderId,
  type TextPatch,
  type TestRunObservation,
  type ToolCall,
  type ToolDefinition,
  type ToolResult,
  type TokenBudgetConfig,
  type TokenBudgetState
} from "@buildr/core";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import * as vscode from "vscode";
import { BuildrSecretStore } from "./credentials.js";
import { inferFastAgentNewFileTarget, isFastAgentEditablePath, normalizeWorkspacePath } from "./fastAgentTarget.js";
import { registerBuildrChatParticipant } from "./native/chatParticipant.js";
import { runDebugFromInput } from "./native/debugMode.js";
import { readDiagnosticsSummary } from "./native/diagnostics.js";
import { registerBuildrLanguageModelTools } from "./native/languageModelTools.js";
import { showMcpDoctor, showMcpList } from "./native/mcpCommands.js";
import { openBuildrSettings } from "./native/settings.js";
import { findTaskCommand, runCommandAsVscodeTask } from "./native/tasks.js";
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
let pendingApproval: PendingApproval<BuildrApprovalPayload> | undefined;
let pendingAgentRetryResolver: ((continueWorkflow: boolean) => void) | undefined;
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
let contextWindowTokens: number | undefined;
let contextWindowKey: string | undefined;
// Estimated input/context-window size (in tokens) of the most recent prompt
// actually sent to the model, across chat, ask, and agent paths. This is what
// the context indicator reports — not the chat transcript, which only reflects
// visible turns and tracks model output rather than the context window.
let lastContextTokens: number | undefined;
let extensionContext: vscode.ExtensionContext | undefined;
let providerSecrets: BuildrSecretStore | undefined;
let activeSessionId = "";
let savedAgentSessions: PersistedAgentSession[] = [];
let agentPipelineState: AgentPipelineState | undefined;

interface TerminalApprovalPayload {
  command: string;
  cwd: string;
  agentTestCaseId?: string;
}

interface AgentRetryApprovalPayload {
  taskId: string;
  taskTitle: string;
  maxAttempts: number;
  lastFailure?: string;
}

type BuildrApprovalPayload = TextPatch | TerminalApprovalPayload | AgentRetryApprovalPayload;

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

type AgentPipelinePhase = "idle" | "planning" | "coding" | "reviewing" | "linting" | "testing" | "complete" | "blocked" | "failed";

interface AgentPipelineState {
  phase: AgentPipelinePhase;
  rawTask: string;
  workspaceTree: string[];
  verificationMode?: "llm" | "skip";
  plan?: AgentPlan;
  currentTaskIndex: number;
  coderResults: AgentCoderPipelineResult[];
  reviewResults: AgentReviewPipelineResult[];
  testCases: AgentTestCase[];
  testObservations: TestRunObservation[];
  retryCount: Record<string, number>;
  lintFixCount?: number | undefined;
  finalSummary?: string;
  warnings: string[];
  activeStream?: {
    role: string;
    label: string;
    raw: string;
    active: boolean;
  } | undefined;
}

interface AgentCoderPipelineResult {
  taskId: string;
  attempt: number;
  output: CoderOutput;
  patches: TextPatch[];
  formattedDiff: string;
}

interface AgentReviewPipelineResult {
  taskId: string;
  status: "approved" | "changes_needed";
  issues: string[];
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
  pendingApproval?: PendingApproval<BuildrApprovalPayload>;
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
  agentPipelineState?: AgentPipelineState;
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
  renderCurrentState(stepPanel, undefined, { reveal: true });
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
  renderCurrentState(stepPanel, undefined, { reveal: true });
}

function deleteAgentSession(id: string, stepPanel: StepPanel): void {
  if (isRunning) {
    vscode.window.showWarningMessage("Stop the active Buildr operation before deleting an agent.");
    renderCurrentState(stepPanel);
    return;
  }
  const beforeCount = savedAgentSessions.length;
  savedAgentSessions = savedAgentSessions.filter((session) => session.id !== id);
  if (savedAgentSessions.length === beforeCount) {
    vscode.window.showWarningMessage("Buildr could not find that saved agent.");
    renderCurrentState(stepPanel);
    return;
  }

  if (id === activeSessionId) {
    const next = savedAgentSessions[0];
    if (next !== undefined) {
      restoreAgentSession(next);
    } else {
      createBlankAgentSession();
    }
  }

  void extensionContext?.workspaceState.update(AGENT_SESSIONS_KEY, savedAgentSessions);
  renderCurrentState(stepPanel, undefined, { reveal: true });
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
  lastContextTokens = undefined;
  currentPlanMentionedFiles = [...session.state.currentPlanMentionedFiles];
  finalSummaryState = session.state.finalSummary;
  agentPipelineState = session.state.agentPipelineState;
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
  lastContextTokens = undefined;
  currentPlanMentionedFiles = [];
  finalSummaryState = undefined;
  agentPipelineState = undefined;
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
    ...(agentPipelineState === undefined ? {} : { agentPipelineState }),
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
  providerSecrets = secretStore;
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
  stepPanel.onDeleteSession((id) => {
    deleteAgentSession(id, stepPanel);
  });
  stepPanel.onNewSession(() => {
    createNewAgentSession(stepPanel);
  });
  stepPanel.onRunPlan(() => {
    void runCurrentPlanFromUi(stepPanel);
  });
  stepPanel.onRunPlanFast(() => {
    void runCurrentPlanFastFromUi(stepPanel);
  });
  stepPanel.onChangePlan(() => {
    changeCurrentPlan(stepPanel);
  });
  stepPanel.onStop(() => {
    stopActiveOperation(stepPanel);
  });
  stepPanel.onCompact(() => {
    compactConversationContext(stepPanel);
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
        await runDeterministicAgentWorkflowFromCurrentPlan(stepPanel);
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
          label: "OpenAI",
          value: "openai",
          description: "Uses https://api.openai.com/v1"
        },
        {
          label: "OpenRouter",
          value: "openrouter",
          description: "Uses https://openrouter.ai/api/v1"
        },
        {
          label: "Anthropic",
          value: "anthropic",
          description: "Uses Anthropic Messages API"
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

      const selectedProvider = parseProvider(provider.value);
      const urlKey = providerUrlSettingKey(selectedProvider);
      const defaultUrl = defaultProviderBaseUrl(selectedProvider);
      const currentUrl = config.get<string>(urlKey, defaultUrl);
      const nextUrl = await vscode.window.showInputBox({
        title: `Buildr: Configure ${provider.label} Endpoint`,
        prompt: provider.value === "anthropic"
          ? "Base URL only. Example: https://api.anthropic.com"
          : provider.value === "ollama"
            ? "Base URL only. Example: http://127.0.0.1:11434"
            : "Base URL only, without /v1. Example: https://api.openai.com",
        value: currentUrl,
        ignoreFocusOut: true
      });

      if (nextUrl) {
        await config.update(urlKey, stripProviderVersionSuffix(selectedProvider, nextUrl), vscode.ConfigurationTarget.Workspace);
      }

      if (!isLocalProvider(selectedProvider, stripProviderVersionSuffix(selectedProvider, nextUrl ?? currentUrl))) {
        const secret = await vscode.window.showInputBox({
          title: "Buildr: Provider API Key",
          prompt: "API key for this cloud provider. Leave blank to keep an existing saved key.",
          password: true,
          ignoreFocusOut: true
        });
        if (secret !== undefined && secret.length > 0) {
          await secretStore.storeProviderSecret(providerSecretKey(selectedProvider), secret);
          vscode.window.showInformationMessage("Buildr stored provider secret in VS Code SecretStorage.");
        }
      }

      const modelAdapter = BuildrCore.createModelAdapter({
        provider: selectedProvider,
        baseUrl: stripProviderVersionSuffix(selectedProvider, nextUrl ?? currentUrl),
        getApiKey: () => providerSecrets?.getProviderSecret(providerSecretKey(selectedProvider)) ?? Promise.resolve(undefined)
      });
      const modelId = await selectModelId(modelAdapter, provider.label, config.get<string>("modelId", "qwen2.5-coder"));
      if (modelId === undefined) {
        return;
      }
      await config.update("modelId", modelId, vscode.ConfigurationTarget.Workspace);

      vscode.window.showInformationMessage(`Buildr model set to ${provider.label}.`);
      void refreshContextWindow(stepPanel);
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
  const { provider, baseUrl } = getConfiguredProviderAndBaseUrl();
  const model = BuildrCore.createModelAdapter({
    provider,
    baseUrl,
    getApiKey: () => providerSecrets?.getProviderSecret(providerSecretKey(provider)) ?? Promise.resolve(undefined)
  });
  return new BuildrCore({ model });
}

function getConfiguredProviderAndBaseUrl(): { provider: ProviderId; baseUrl: string } {
  const modelConfig = vscode.workspace.getConfiguration("buildr.model");
  const provider = parseProvider(modelConfig.get<string>("provider", "ollama"));
  const baseUrl = modelConfig.get<string>(providerUrlSettingKey(provider), defaultProviderBaseUrl(provider));
  return { provider, baseUrl };
}

function getConfiguredModelId(): string {
  const modelConfig = vscode.workspace.getConfiguration("buildr.model");
  return modelConfig.get<string>("modelId", "qwen2.5-coder");
}

function parseProvider(value: string): ProviderId {
  if (
    value === "ollama"
    || value === "lmstudio-openai"
    || value === "lmstudio-native"
    || value === "openai-compatible"
    || value === "openai"
    || value === "openrouter"
    || value === "anthropic"
  ) {
    return value;
  }
  return "ollama";
}

function stripOpenAiVersionSuffix(value: string): string {
  return value.trim().replace(/\/v1\/?$/u, "");
}

function stripProviderVersionSuffix(provider: ProviderId, value: string): string {
  return provider === "ollama" || provider === "anthropic" ? value.trim().replace(/\/$/, "") : stripOpenAiVersionSuffix(value);
}

function providerUrlSettingKey(provider: ProviderId): string {
  switch (provider) {
    case "ollama":
      return "ollamaBaseUrl";
    case "lmstudio-openai":
    case "lmstudio-native":
    case "openai-compatible":
      return "lmStudioBaseUrl";
    case "openai":
      return "openAiBaseUrl";
    case "openrouter":
      return "openRouterBaseUrl";
    case "anthropic":
      return "anthropicBaseUrl";
  }
}

function defaultProviderBaseUrl(provider: ProviderId): string {
  switch (provider) {
    case "ollama":
      return "http://127.0.0.1:11434";
    case "lmstudio-openai":
    case "lmstudio-native":
    case "openai-compatible":
      return "http://127.0.0.1:1234";
    case "openai":
      return "https://api.openai.com";
    case "openrouter":
      return "https://openrouter.ai/api";
    case "anthropic":
      return "https://api.anthropic.com";
  }
}

function providerSecretKey(provider: ProviderId): string {
  switch (provider) {
    case "openai":
      return "openai";
    case "openrouter":
      return "openrouter";
    case "anthropic":
      return "anthropic";
    case "openai-compatible":
      return "openaiCompatible";
    case "ollama":
    case "lmstudio-openai":
    case "lmstudio-native":
      return provider;
  }
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
  activePrompt = "";
  finalSummaryState = undefined;
  messages.push({
    role: "user",
    text: `${modeLabel(message.mode)}: ${prompt}`
  });
  renderCurrentState(stepPanel);

  if (message.mode === "debug") {
    isRunning = true;
    activeAbortController = new AbortController();
    messages.push({
      role: "assistant",
      text: "Opening Debug Mode input."
    });
    renderCurrentState(stepPanel);
    try {
      await runDebugFromInput();
    } finally {
      isRunning = false;
      activeAbortController = undefined;
      renderCurrentState(stepPanel);
    }
    return;
  }

  if (message.mode === "ask") {
    isRunning = true;
    renderCurrentState(stepPanel);
    activeAbortController = new AbortController();
    try {
      await answerGeneralQuestion(prompt, message.fileMentions, stepPanel);
    } finally {
      isRunning = false;
      activeAbortController = undefined;
      renderCurrentState(stepPanel);
    }
    return;
  }

  if (message.mode === "agent") {
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
    activeAbortController = new AbortController();
    renderCurrentState(stepPanel);
    try {
      await runDeterministicAgentWorkflow(prompt, message.fileMentions, stepPanel);
    } finally {
      isRunning = false;
      activeAbortController = undefined;
      renderCurrentState(stepPanel);
    }
    return;
  }

  if (message.mode === "fast-agent") {
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
    activeAbortController = new AbortController();
    renderCurrentState(stepPanel);
    try {
      await runFastAgentWorkflow(prompt, message.fileMentions, stepPanel);
    } finally {
      isRunning = false;
      activeAbortController = undefined;
      renderCurrentState(stepPanel);
    }
    return;
  }

  await createPlanFromGoal(prompt, message.fileMentions, stepPanel);
}

function compactConversationContext(stepPanel: StepPanel): void {
  if (isRunning) {
    return;
  }

  const keepRecent = 2;
  if (messages.length <= keepRecent + 1) {
    messages.push({ role: "assistant", text: "Conversation is already compact." });
    renderCurrentState(stepPanel);
    return;
  }

  const older = messages.slice(0, messages.length - keepRecent);
  const recent = messages.slice(-keepRecent);
  const compacted = compactAgentContext({
    goal: latestUserGoal(older) ?? "Conversation so far",
    transcript: older,
    maxChars: 6000
  });

  messages = [
    {
      role: "assistant",
      text: [
        `Compacted ${older.length} earlier message(s). This only shrinks the conversation transcript passed to multi-step agent runs.`,
        "The per-request context shown in the indicator is built fresh on each call and is not affected.",
        "",
        compacted.text
      ].join("\n")
    },
    ...recent
  ];
  renderCurrentState(stepPanel);
}

function latestUserGoal(history: ChatMessage[]): string | undefined {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    if (message === undefined || message.role !== "user") {
      continue;
    }
    const colonIndex = message.text.indexOf(": ");
    return colonIndex === -1 ? message.text : message.text.slice(colonIndex + 2);
  }
  return undefined;
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
    await runDeterministicAgentWorkflowFromCurrentPlan(stepPanel);
  } finally {
    isRunning = false;
    renderCurrentState(stepPanel);
  }
}

async function runCurrentPlanFastFromUi(stepPanel: StepPanel): Promise<void> {
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

  activeMode = "fast-agent";
  isRunning = true;
  activeAbortController = new AbortController();
  renderCurrentState(stepPanel);
  try {
    await runFastAgentWorkflow(currentPlan.goal, fastPlanFileMentions(currentPlan), stepPanel);
  } finally {
    isRunning = false;
    activeAbortController = undefined;
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
  if (!await ensureCloudProviderReady("create a plan with workspace context")) {
    return undefined;
  }
  isRunning = true;
  activeAbortController = new AbortController();
  archiveCurrentPlan();
  activePrompt = "";
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

async function answerGeneralQuestion(question: string, fileMentions: string[], stepPanel: StepPanel): Promise<void> {
  if (!await ensureCloudProviderReady("answer with workspace context")) {
    messages.push({ role: "assistant", text: "Buildr did not send workspace context to the configured cloud provider." });
    renderCurrentState(stepPanel);
    return;
  }
  const resolvedMentions = resolveFileMentions(fileMentions);
  const mentionContext = await createAskMentionContext(resolvedMentions);
  const configuredCore = createConfiguredCore();
  const modelId = getConfiguredModelId();
  const askTools = getAskTools();
  const modelMessages: CoreChatMessage[] = createAskMessages(question, mentionContext);
  const consulted = new Set<string>(resolvedMentions);
  let answer = "";

  for (let round = 0; round < 4; round += 1) {
    let roundText = "";
    const toolCalls: ToolCall[] = [];
    lastContextTokens = estimateCoreContextTokens(modelMessages);
    renderCurrentState(stepPanel);
    for await (const delta of configuredCore.model.chat({
      model: modelId,
      temperature: 0.2,
      messages: modelMessages,
      tools: askTools
    }, activeAbortController?.signal === undefined ? {} : { signal: activeAbortController.signal })) {
      if (delta.type === "text" && delta.content !== undefined) {
        roundText += delta.content;
      }
      if (delta.type === "tool_call" && delta.toolCall !== undefined) {
        toolCalls.push(delta.toolCall);
      }
    }

    if (toolCalls.length === 0) {
      answer = roundText.trim();
      break;
    }

    modelMessages.push({
      role: "assistant",
      content: roundText,
      toolCalls
    });
    const capabilities = await configuredCore.model.getCapabilities(modelId);
    const allReadOnly = toolCalls.every((tc) => tc.name === "read_file" || tc.name === "search_codebase" || tc.name === "read_diagnostics");
    if (capabilities.parallelTools && allReadOnly && toolCalls.length > 1) {
      const results = await Promise.all(toolCalls.map((toolCall) => runAskTool(toolCall)));
      for (const [index, toolCall] of toolCalls.entries()) {
        const result = results[index]!;
        events.push(eventFromToolResult(
          `ask:${toolCall.name}:${Date.now()}`,
          `Ask tool: ${toolCall.name}`,
          toolCall.name,
          result,
          result.provenance[0]?.source
        ));
        for (const provenance of result.provenance) {
          if (provenance.kind === "file") {
            consulted.add(provenance.source);
          }
        }
        modelMessages.push({
          role: "tool",
          name: toolCall.name,
          toolCallId: toolCall.id,
          content: JSON.stringify(result)
        });
      }
    } else {
      for (const toolCall of toolCalls) {
        const result = await runAskTool(toolCall);
        events.push(eventFromToolResult(
          `ask:${toolCall.name}:${Date.now()}`,
          `Ask tool: ${toolCall.name}`,
          toolCall.name,
          result,
          result.provenance[0]?.source
        ));
        for (const provenance of result.provenance) {
          if (provenance.kind === "file") {
            consulted.add(provenance.source);
          }
        }
        modelMessages.push({
          role: "tool",
          name: toolCall.name,
          toolCallId: toolCall.id,
          content: JSON.stringify(result)
        });
      }
    }
    renderCurrentState(stepPanel);
  }

  if (answer.length === 0) {
    events.push({
      id: `ask:tool-limit:${Date.now()}`,
      title: "Ask tool limit reached",
      status: "blocked",
      tool: "ask",
      summary: "Ask mode stopped after reaching the read-only tool call limit.",
      warnings: ["The model did not produce a final answer after tool use."]
    });
    answer = "I stopped after reaching the read-only tool call limit before a final answer was produced.";
  }

  const consultedNote = consulted.size === 0
    ? ""
    : `\n\nConsulted repo files/tools: ${Array.from(consulted).join(", ")}`;
  messages.push({
    role: "assistant",
    text: `${answer || "I could not produce an answer."}${consultedNote}`
  });
  renderCurrentState(stepPanel);
}

function createAskMessages(question: string, mentionContext: string): CoreChatMessage[] {
  return [
    {
      role: "system",
      content: [
        "You are Buildr Ask Mode.",
        "Answer general questions directly. Do not assume the user is asking about this repository unless they say so.",
        "When repository context is needed, use the available read-only tools instead of guessing.",
        "Do not create plans, propose patches, edit files, or run terminal commands in Ask Mode."
      ].join("\n")
    },
    {
      role: "user",
      content: mentionContext.length === 0
        ? question
        : [question, "", "User-mentioned repo file excerpts:", mentionContext].join("\n")
    }
  ];
}

async function createAskMentionContext(mentionedFiles: string[]): Promise<string> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (root === undefined || mentionedFiles.length === 0) {
    return "";
  }
  const excerpts: string[] = [];
  for (const relativePath of mentionedFiles) {
    const absolute = resolve(root, relativePath);
    if (!isWorkspaceRelativePath(root, absolute)) {
      continue;
    }
    const content = await readTextFileIfExists(absolute);
    if (content.length > 0) {
      excerpts.push(`- ${relativePath}:\n${summarizeMentionedFile(content)}`);
    }
  }
  return excerpts.join("\n\n");
}

function getAskTools(): ToolDefinition[] {
  return builtInTools.filter((tool) => tool.name === "read_file" || tool.name === "search_codebase" || tool.name === "read_diagnostics");
}

async function runAskTool(toolCall: ToolCall): Promise<ToolResult> {
  const tool = getAskTools().find((candidate) => candidate.name === toolCall.name);
  if (tool === undefined) {
    return failedToolResult(`Ask Mode cannot use tool "${toolCall.name}".`, toolCall.name);
  }
  const target = askToolTarget(toolCall);
  const decision = createConfiguredCore().permissions.decide(target === undefined ? { tool } : { tool, target });
  if (decision === "deny" || decision === "ask") {
    return failedToolResult(`Ask Mode blocked ${toolCall.name}; this mode only auto-runs safe read-only tools.`, toolCall.name);
  }
  try {
    switch (toolCall.name) {
      case "read_file":
        return await runAskReadFileTool(toolCall);
      case "search_codebase":
        return await runAskSearchTool(toolCall);
      case "read_diagnostics":
        return runAskDiagnosticsTool();
      default:
        return failedToolResult(`Ask Mode cannot use tool "${toolCall.name}".`, toolCall.name);
    }
  } catch (error) {
    return failedToolResult(error instanceof Error ? error.message : String(error), toolCall.name);
  }
}

async function runAskReadFileTool(toolCall: ToolCall): Promise<ToolResult> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const rawPath = typeof toolCall.arguments.path === "string" ? toolCall.arguments.path : "";
  if (root === undefined) {
    return failedToolResult("No workspace folder is open.", "read_file");
  }
  if (rawPath.trim().length === 0) {
    return failedToolResult("read_file requires a path.", "read_file");
  }
  const absolute = resolve(root, normalizeWorkspacePath(rawPath));
  if (!isWorkspaceRelativePath(root, absolute)) {
    return failedToolResult(`Blocked reading outside the workspace: ${rawPath}`, "read_file");
  }
  return readFileTool(absolute);
}

async function runAskSearchTool(toolCall: ToolCall): Promise<ToolResult> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const query = typeof toolCall.arguments.query === "string" ? toolCall.arguments.query : "";
  if (root === undefined) {
    return failedToolResult("No workspace folder is open.", "search_codebase");
  }
  if (query.trim().length === 0) {
    return failedToolResult("search_codebase requires a query.", "search_codebase");
  }
  return searchCodebaseTool(root, query);
}

function runAskDiagnosticsTool(): ToolResult<{ diagnostics: string }> {
  const diagnostics = readDiagnosticsSummary();
  return {
    ok: true,
    summary: diagnostics.message,
    data: { diagnostics: diagnostics.message },
    warnings: [],
    provenance: [{ kind: "diagnostic", source: "vscode.problems" }]
  };
}

function askToolTarget(toolCall: ToolCall): string | undefined {
  if (toolCall.name === "read_file" && typeof toolCall.arguments.path === "string") {
    return toolCall.arguments.path;
  }
  if (toolCall.name === "search_codebase" && typeof toolCall.arguments.query === "string") {
    return toolCall.arguments.query;
  }
  return undefined;
}

function failedToolResult(summary: string, source: string): ToolResult {
  return {
    ok: false,
    summary,
    warnings: [summary],
    provenance: [{ kind: "generated", source }]
  };
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

function selectFastAgentTargetFiles(rawTask: string, mentionedFiles: string[], context: WorkspaceContextSummary): string[] {
  const generatedTarget = mentionedFiles.length === 0 ? inferFastAgentNewFileTarget(rawTask) : undefined;
  const candidates = mentionedFiles.length > 0
    ? mentionedFiles
    : generatedTarget === undefined ? context.includedFiles : [generatedTarget, ...context.includedFiles];
  return [...new Set(candidates)]
    .filter((path) => isFastAgentEditablePath(path))
    .slice(0, 2);
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
    case "fast-agent":
      return "Fast Agent";
    case "agent":
      return "Agent";
    case "debug":
      return "Debug";
    case "plan":
      return "Plan";
  }
}

function fastPlanFileMentions(plan: BuildrPlan): string[] {
  return plan.steps
    .filter((step) => step.kind === "write")
    .flatMap((step) => step.targets)
    .map(normalizeWorkspacePath)
    .filter((target) => {
      if (
        target.length === 0 ||
        target === "." ||
        target.includes("${") ||
        target.includes("*") ||
        target.endsWith("/") ||
        target.toLowerCase().includes("approved ")
      ) {
        return false;
      }
      return isFastAgentEditablePath(target);
    })
    .slice(0, 2);
}

function stopActiveOperation(stepPanel: StepPanel): void {
  activeAbortController?.abort();
  activeAbortController = undefined;
  isRunning = false;
  if (pendingApproval?.tool === "agent_retry") {
    pendingApproval = undefined;
  }
  pendingAgentRetryResolver?.(false);
  pendingAgentRetryResolver = undefined;
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

async function runFastAgentWorkflow(rawTask: string, fileMentions: string[], stepPanel: StepPanel): Promise<void> {
  if (!await ensureCloudProviderReady("run Fast Agent mode with workspace context")) {
    messages.push({ role: "assistant", text: "Buildr did not send workspace context to the configured cloud provider." });
    renderCurrentState(stepPanel);
    return;
  }
  events = [];
  pendingApproval = undefined;
  queuedVerificationCommand = undefined;
  queuedWriteTargets = [];
  queuedPatchApprovals = [];
  finalSummaryState = undefined;
  tokenBudgetState = undefined;

  const resolvedMentions = resolveFileMentions(fileMentions);
  currentPlanMentionedFiles = resolvedMentions;
  const context = await createWorkspaceContextSummary(rawTask, resolvedMentions);
  const targetFiles = selectFastAgentTargetFiles(rawTask, resolvedMentions, context);
  if (targetFiles.length === 0) {
    const summary = "Fast Agent could not select a concrete target file. Mention a file with @path or use Agent mode for automatic planning.";
    events.push({
      id: `agent:fast:no-target:${Date.now()}`,
      title: "Fast Agent target selection",
      status: "blocked",
      tool: "agent_orchestrator",
      summary,
      warnings: context.warnings
    });
    messages.push({ role: "assistant", text: summary });
    renderCurrentState(stepPanel, createFinalReportSummary());
    return;
  }

  const task: AgentPlanTask = {
    id: "fast_patch",
    title: "Fast patch",
    instructions: [
      rawTask,
      "",
      "Implement the smallest safe change that satisfies the request.",
      "Do not refactor unrelated code."
    ].join("\n"),
    targetFiles,
    dependsOn: [],
    acceptanceCriteria: ["The requested small change is implemented in the selected target file(s)."]
  };
  const plan: AgentPlan = {
    summary: `Fast Agent patch for ${rawTask}`,
    tasks: [task]
  };
  agentPipelineState = {
    phase: "coding",
    rawTask,
    workspaceTree: targetFiles,
    verificationMode: "skip",
    plan,
    currentTaskIndex: 0,
    coderResults: [],
    reviewResults: [],
    testCases: [],
    testObservations: [],
    retryCount: {},
    warnings: [...context.warnings, "Fast Agent skipped architect, reviewer, and tester LLM passes."]
  };
  currentPlan = convertAgentPlanToBuildrPlan(rawTask, plan);
  events.push(createContextInspectionEvent(context, "Fast Agent repo context"));
  events.push({
    id: `agent:fast:${Date.now()}`,
    title: "Create fast agent task",
    status: "completed",
    tool: "agent_orchestrator",
    summary: `Selected ${targetFiles.length} target file(s): ${targetFiles.join(", ")}.`,
    warnings: []
  });
  renderCurrentState(stepPanel);

  try {
    const result = await runCoderReviewLoop(task, context, stepPanel, { review: false });
    if (result === undefined) {
      return;
    }
    agentPipelineState.coderResults.push(result);
    queuedPatchApprovals.push(...result.patches.map((patch) => createAgentPatchApproval(task, result, patch)));
    pendingApproval = queuedPatchApprovals.shift();
    if (pendingApproval !== undefined) {
      events.push(eventFromPermissionDecision(pendingApproval, "ask"));
    } else {
      completeAgentPipeline("Fast Agent completed without patch proposals.");
      renderCurrentState(stepPanel, createFinalReportSummary());
      return;
    }
    renderCurrentState(stepPanel);
  } catch (error) {
    failAgentPipeline(error);
  }
}

async function runDeterministicAgentWorkflow(rawTask: string, fileMentions: string[], stepPanel: StepPanel): Promise<void> {
  if (!await ensureCloudProviderReady("run Agent mode with workspace context")) {
    messages.push({ role: "assistant", text: "Buildr did not send workspace context to the configured cloud provider." });
    renderCurrentState(stepPanel);
    return;
  }
  events = [];
  pendingApproval = undefined;
  queuedVerificationCommand = undefined;
  queuedWriteTargets = [];
  queuedPatchApprovals = [];
  finalSummaryState = undefined;
  tokenBudgetState = undefined;

  const resolvedMentions = resolveFileMentions(fileMentions);
  currentPlanMentionedFiles = resolvedMentions;
  const context = await createWorkspaceContextSummary(rawTask, resolvedMentions);
  const workspaceTree = await createWorkspaceTree();
  agentPipelineState = {
    phase: "planning",
    rawTask,
    workspaceTree,
    verificationMode: "llm",
    currentTaskIndex: 0,
    coderResults: [],
    reviewResults: [],
    testCases: [],
    testObservations: [],
    retryCount: {},
    warnings: [...context.warnings]
  };
  events.push(createContextInspectionEvent(context, "Agent repo context"));
  renderCurrentState(stepPanel);

  try {
    const architect = await invokeStreamingJsonAgent("architect", "Architect: planning", createArchitectMessages({
      requestId: createAgentRequestId("architect"),
      rawTask: appendMentionHint(rawTask, resolvedMentions),
      workspaceTree,
      workspaceSummary: context.text
    }), validateArchitectOutput, stepPanel);
    agentPipelineState.plan = architect.data.plan;
    agentPipelineState.warnings.push(...architect.warnings);
    currentPlan = convertAgentPlanToBuildrPlan(rawTask, architect.data.plan);
    const architectEvidence = lastStreamEvidence();
    events.push({
      id: `agent:architect:${Date.now()}`,
      title: "Architect plan",
      status: "completed",
      tool: "agent_architect",
      summary: `Created deterministic plan with ${architect.data.plan.tasks.length} task(s).`,
      warnings: architect.warnings,
      ...(architectEvidence === undefined ? {} : { evidence: architectEvidence })
    });
    renderCurrentState(stepPanel);

    const completed = await createReviewedPatchApprovals(architect.data.plan, context, stepPanel);
    if (completed && pendingApproval === undefined && queuedPatchApprovals.length === 0) {
      await queueAgentTestGeneration(stepPanel);
    }
  } catch (error) {
    failAgentPipeline(error);
  }
}

async function runDeterministicAgentWorkflowFromCurrentPlan(stepPanel: StepPanel): Promise<void> {
  if (currentPlan === undefined) {
    return;
  }
  if (!await ensureCloudProviderReady("run the approved plan with workspace context")) {
    messages.push({ role: "assistant", text: "Buildr did not send workspace context to the configured cloud provider." });
    renderCurrentState(stepPanel);
    return;
  }
  events = [];
  pendingApproval = undefined;
  queuedVerificationCommand = undefined;
  queuedWriteTargets = [];
  queuedPatchApprovals = [];
  finalSummaryState = undefined;
  tokenBudgetState = undefined;

  const context = await createWorkspaceContextSummary(currentPlan.goal, currentPlanMentionedFiles);
  const plan = convertBuildrPlanToAgentPlan(currentPlan);
  agentPipelineState = {
    phase: "coding",
    rawTask: currentPlan.goal,
    workspaceTree: await createWorkspaceTree(),
    verificationMode: "llm",
    plan,
    currentTaskIndex: 0,
    coderResults: [],
    reviewResults: [],
    testCases: [],
    testObservations: [],
    retryCount: {},
    warnings: [...context.warnings]
  };
  events.push(createContextInspectionEvent(context, "Agent repo context"));
  try {
    const completed = await createReviewedPatchApprovals(plan, context, stepPanel);
    if (completed && pendingApproval === undefined && queuedPatchApprovals.length === 0) {
      await queueAgentTestGeneration(stepPanel);
    }
  } catch (error) {
    failAgentPipeline(error);
  }
}

async function createReviewedPatchApprovals(plan: AgentPlan, context: WorkspaceContextSummary, stepPanel: StepPanel): Promise<boolean> {
  if (agentPipelineState === undefined) {
    return false;
  }
  for (const [taskIndex, task] of plan.tasks.entries()) {
    agentPipelineState.phase = "coding";
    agentPipelineState.currentTaskIndex = taskIndex;
    renderCurrentState(stepPanel);
    const result = await runCoderReviewLoop(task, context, stepPanel);
    if (result === undefined) {
      return false;
    }
    agentPipelineState.coderResults.push(result);
    queuedPatchApprovals.push(...result.patches.map((patch) => createAgentPatchApproval(task, result, patch)));
    renderCurrentState(stepPanel);
  }

  pendingApproval = queuedPatchApprovals.shift();
  if (pendingApproval !== undefined) {
    events.push(eventFromPermissionDecision(pendingApproval, "ask"));
  }
  return true;
}

async function runCoderReviewLoop(
  task: AgentPlanTask,
  context: WorkspaceContextSummary,
  stepPanel: StepPanel,
  options: { review?: boolean } = {}
): Promise<AgentCoderPipelineResult | undefined> {
  if (agentPipelineState === undefined) {
    throw new Error("Agent pipeline state is not initialized.");
  }
  let feedback: string | undefined;
  let lastFailure: string | undefined;
  // Consecutive attempts that failed with the same message after the retry cap
  // was bypassed. A deterministic failure (e.g. an unimplementable task) repeats
  // identically forever, so we stop instead of looping until the user kills it.
  let noProgressStreak = 0;
  const maxAttempts = getCoderRetryLimit();
  let retryLimitBypassed = false;
  const recordFailure = (summary: string): void => {
    noProgressStreak = summary === lastFailure ? noProgressStreak + 1 : 0;
    lastFailure = summary;
  };
  for (let attempt = 1; ; attempt += 1) {
    if (retryLimitBypassed && noProgressStreak >= NO_PROGRESS_STOP_THRESHOLD) {
      blockAgentPipelineOnNoProgress(task, attempt - 1, lastFailure);
      renderCurrentState(stepPanel);
      return undefined;
    }
    if (!retryLimitBypassed && attempt > maxAttempts) {
      const shouldContinue = await promptToContinueAfterRetryLimit(task, maxAttempts, lastFailure, stepPanel);
      if (!shouldContinue) {
        blockAgentPipelineOnRetryLimit(task, maxAttempts, lastFailure);
        renderCurrentState(stepPanel);
        return undefined;
      }
      retryLimitBypassed = true;
      // The user explicitly chose to continue; judge the next attempts fresh so
      // failures accumulated before the cap do not immediately re-trip the stop.
      noProgressStreak = 0;
      lastFailure = undefined;
      events.push({
        id: `agent:coder:${task.id}:${Date.now()}:retry-continued`,
        title: `Continue ${task.title}`,
        status: "running",
        tool: "agent_orchestrator",
        summary: `User continued after ${maxAttempts} attempt(s); retry limit is disabled for this task.`,
        warnings: []
      });
      renderCurrentState(stepPanel);
    }
    agentPipelineState.retryCount[task.id] = attempt - 1;
    const files = await createFileSnapshots(task.targetFiles);
    let coder: AgentJsonEnvelope<CoderOutput>;

    try {
      coder = await invokeStreamingJsonAgent("coder", `Coder: ${task.title} (attempt ${attempt})`, createCoderMessages({
        requestId: createAgentRequestId("coder"),
        input: {
          task,
          files,
          ...(feedback === undefined ? {} : { feedback })
        }
      }), validateCoderOutput, stepPanel);
    } catch (error) {
      const summary = error instanceof Error ? error.message : String(error);
      const coderEvidence = lastStreamEvidence();
      events.push({
        id: `agent:coder:${task.id}:${attempt}:invalid-json`,
        title: `Coder: ${task.title}`,
        status: "failed",
        tool: "agent_coder",
        summary: `Coder returned invalid JSON: ${summary}`,
        warnings: [summary],
        ...(coderEvidence === undefined ? {} : { evidence: coderEvidence })
      });
      recordFailure(summary);
      feedback = [
        "Your previous response was not valid JSON, so Buildr could not validate or apply it.",
        summary,
        "Regenerate the same task as one valid JSON envelope.",
        "Return only JSON. Do not wrap it in Markdown.",
        "Every hunk line must be one JSON string with quotes and backslashes escaped."
      ].join("\n");
      continue;
    }

    let patches: TextPatch[];
    try {
      patches = await createValidatedPatches(coder.data, files);
    } catch (error) {
      const summary = error instanceof Error ? error.message : String(error);
      const coderEvidence = lastStreamEvidence();
      events.push({
        id: `agent:coder:${task.id}:${attempt}:invalid-diff`,
        title: `Coder: ${task.title}`,
        status: "failed",
        tool: "agent_coder",
        summary: `Coder returned invalid diffs: ${summary}`,
        warnings: coder.warnings,
        ...(coderEvidence === undefined ? {} : { evidence: coderEvidence })
      });
      recordFailure(summary);
      feedback = [
        "Your previous diffs failed deterministic patch validation.",
        summary,
        "Regenerate the same task as valid structured diffs.",
        "Every hunk line must start with exactly one of: space for context, + for additions, - for removals.",
        "For a new file, every content line in the hunk must be prefixed with '+'."
      ].join("\n");
      continue;
    }
    const formattedDiff = patches.map((patch) => formatPatchForWorkspace(patch)).join("\n\n");
    const coderResult: AgentCoderPipelineResult = {
      taskId: task.id,
      attempt,
      output: coder.data,
      patches,
      formattedDiff
    };
    events.push({
      id: `agent:coder:${task.id}:${attempt}`,
      title: `Coder: ${task.title}`,
      status: "completed",
      tool: "agent_coder",
      summary: coder.data.summary,
      evidence: { outputExcerpt: formattedDiff.slice(0, 4000) },
      warnings: coder.warnings
    });

    if (options.review === false) {
      events.push({
        id: `agent:reviewer:${task.id}:${attempt}:skipped`,
        title: `Reviewer: ${task.title}`,
        status: "completed",
        tool: "agent_reviewer",
        summary: "Skipped reviewer in Fast Agent mode.",
        warnings: ["Fast Agent skips reviewer to reduce latency."]
      });
      return coderResult;
    }

    agentPipelineState.phase = "reviewing";
    const reviewer = await invokeStreamingJsonAgent("reviewer", `Reviewer: ${task.title} (attempt ${attempt})`, createReviewerMessages({
      requestId: createAgentRequestId("reviewer"),
      task,
      coderOutput: coder.data
    }), validateReviewerOutput, stepPanel);
    const issues = reviewer.data.status === "changes_needed" ? reviewer.data.issues : [];
    agentPipelineState.reviewResults.push({
      taskId: task.id,
      status: reviewer.data.status,
      issues
    });
    const reviewerEvidence = lastStreamEvidence();
    events.push({
      id: `agent:reviewer:${task.id}:${attempt}`,
      title: `Reviewer: ${task.title}`,
      status: reviewer.data.status === "approved" ? "completed" : "failed",
      tool: "agent_reviewer",
      summary: reviewer.data.status === "approved" ? "Reviewer approved the diff." : `Reviewer requested changes: ${issues.join("; ")}`,
      warnings: reviewer.warnings,
      ...(reviewerEvidence === undefined ? {} : { evidence: reviewerEvidence })
    });
    if (reviewer.data.status === "approved") {
      return coderResult;
    }
    feedback = issues.join("\n");
    recordFailure(feedback);
  }

}

async function promptToContinueAfterRetryLimit(
  task: AgentPlanTask,
  maxAttempts: number,
  lastFailure: string | undefined,
  stepPanel: StepPanel
): Promise<boolean> {
  pendingApproval = createAgentRetryApproval(task, maxAttempts, lastFailure);
  events.push({
    id: `agent:coder:${task.id}:${Date.now()}:retry-limit`,
    title: `Retry limit reached: ${task.title}`,
    status: "pending_approval",
    tool: "agent_orchestrator",
    summary: `Coder/reviewer retry limit reached after ${maxAttempts} attempt(s). Waiting for user decision.`,
    warnings: lastFailure === undefined ? [] : [lastFailure]
  });
  events.push(eventFromPermissionDecision(pendingApproval, "ask"));
  renderCurrentState(stepPanel);
  return new Promise((resolvePromise) => {
    pendingAgentRetryResolver = resolvePromise;
  });
}

function createAgentRetryApproval(task: AgentPlanTask, maxAttempts: number, lastFailure: string | undefined): PendingApproval<AgentRetryApprovalPayload> {
  const details = [
    `Buildr reached the configured coder/reviewer retry limit for ${task.title}.`,
    `Attempts: ${maxAttempts}`,
    "",
    "Continue disables the retry cap for this task only. Stop ends the agent workflow without treating it as a crash.",
    lastFailure === undefined ? "" : `Last failure:\n${lastFailure}`
  ].filter((part) => part.length > 0).join("\n");
  return {
    id: `approval:agent_retry:${Date.now()}:${task.id}`,
    title: `Continue ${task.title}?`,
    tool: "agent_retry",
    risk: "medium",
    details,
    payload: {
      taskId: task.id,
      taskTitle: task.title,
      maxAttempts,
      ...(lastFailure === undefined ? {} : { lastFailure })
    }
  };
}

// After the user bypasses the retry cap, stop once this many consecutive
// attempts fail with the identical message — that means the loop is stuck, not
// progressing, and would otherwise run until the user manually aborts it.
const NO_PROGRESS_STOP_THRESHOLD = 2;

function blockAgentPipelineOnNoProgress(task: AgentPlanTask, attempts: number, lastFailure: string | undefined): void {
  const summary = [
    `Agent workflow stopped: ${task.title} made no progress across repeated attempts (${attempts} total) and kept failing identically.`,
    lastFailure === undefined ? "" : `Repeated failure: ${lastFailure}`
  ].filter((part) => part.length > 0).join("\n");
  if (agentPipelineState !== undefined) {
    agentPipelineState.phase = "blocked";
    agentPipelineState.finalSummary = summary;
    agentPipelineState.warnings.push(summary);
  }
  events.push({
    id: `agent:coder:${task.id}:${Date.now()}:no-progress-stopped`,
    title: `Stopped ${task.title}`,
    status: "blocked",
    tool: "agent_orchestrator",
    summary,
    warnings: []
  });
  messages.push({ role: "assistant", text: summary });
}

function blockAgentPipelineOnRetryLimit(task: AgentPlanTask, maxAttempts: number, lastFailure: string | undefined): void {
  const summary = [
    `Agent workflow stopped after reaching the retry limit for ${task.title} (${maxAttempts} attempt(s)).`,
    lastFailure === undefined ? "" : `Last failure: ${lastFailure}`
  ].filter((part) => part.length > 0).join("\n");
  if (agentPipelineState !== undefined) {
    agentPipelineState.phase = "blocked";
    agentPipelineState.finalSummary = summary;
    agentPipelineState.warnings.push(summary);
  }
  events.push({
    id: `agent:coder:${task.id}:${Date.now()}:retry-stopped`,
    title: `Stopped ${task.title}`,
    status: "blocked",
    tool: "agent_orchestrator",
    summary,
    warnings: []
  });
  messages.push({ role: "assistant", text: summary });
}

function getCoderRetryLimit(): number {
  return resolveCoderRetryLimit(
    vscode.workspace.getConfiguration("buildr.agents").get<number>("coderReviewRetryLimit", 0),
    isConfiguredLocalModel()
  );
}

function getLintFixRetryLimit(): number {
  return vscode.workspace.getConfiguration("buildr.agents").get<number>("lintFixRetryLimit", 2);
}

interface LintGateResult {
  passed: boolean;
  output: string;
  command: string;
}

async function getLintCommand(): Promise<string | undefined> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (root !== undefined) {
    try {
      const raw = await readFile(resolve(root, ".buildr/rules/verification.json"), "utf8");
      const config = JSON.parse(raw) as { levels?: { lint?: { preferredCommands?: string[] } } };
      const preferred = config.levels?.lint?.preferredCommands?.[0]?.trim();
      if (preferred !== undefined && preferred.length > 0) {
        return preferred;
      }
    } catch {
      // verification.json missing or malformed -- fall through
    }
  }
  return findTaskCommand("lint");
}

async function runLintGate(stepPanel: StepPanel): Promise<LintGateResult> {
  if (agentPipelineState !== undefined) {
    agentPipelineState.phase = "linting";
  }
  renderCurrentState(stepPanel);

  const command = await getLintCommand();
  if (command === undefined) {
    const diagnostics = readDiagnosticsSummary();
    events.push({
      id: `lint:diagnostics:${Date.now()}`,
      title: "Lint gate (diagnostics)",
      status: diagnostics.count === 0 ? "completed" : "failed",
      tool: "read_diagnostics",
      summary: diagnostics.message,
      evidence: { diagnosticsSummary: diagnostics.message },
      warnings: []
    });
    renderCurrentState(stepPanel);
    return {
      passed: diagnostics.count === 0,
      output: diagnostics.message,
      command: "VS Code diagnostics"
    };
  }

  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? ".";
  const result = await runCommandAsVscodeTask(
    command,
    root,
    activeAbortController?.signal === undefined ? {} : { signal: activeAbortController.signal }
  );
  const passed = result.exitCode === 0;
  const output = [result.stdout, result.stderr].filter((s) => s.length > 0).join("\n").slice(0, 8000);
  events.push({
    id: `lint:command:${Date.now()}`,
    title: "Lint gate",
    status: passed ? "completed" : "failed",
    tool: "run_terminal",
    summary: passed ? `Lint passed: ${command}` : `Lint failed (exit ${result.exitCode ?? "unknown"}): ${command}`,
    evidence: { command, exitCode: result.exitCode ?? 1, outputExcerpt: output.slice(0, 4000) },
    warnings: result.timedOut === true ? ["Lint command timed out."] : []
  });
  renderCurrentState(stepPanel);
  return { passed, output, command };
}

async function runLintAndFixIfNeeded(stepPanel: StepPanel): Promise<void> {
  if (agentPipelineState === undefined) {
    return;
  }

  const maxIterations = getLintFixRetryLimit();
  if (maxIterations <= 0) {
    return;
  }

  const lintResult = await runLintGate(stepPanel);
  if (lintResult.passed) {
    return;
  }

  const lintFixCount = agentPipelineState.lintFixCount ?? 0;
  if (lintFixCount >= maxIterations) {
    events.push({
      id: `lint:fix:exhausted:${Date.now()}`,
      title: "Lint fix limit reached",
      status: "blocked",
      tool: "agent_coder",
      summary: `Could not fix lint errors after ${maxIterations} iteration(s). Continuing without clean lint.`,
      warnings: [`Lint still failing after ${maxIterations} lint-fix iteration(s).`]
    });
    agentPipelineState.warnings.push(`Lint errors remain after ${maxIterations} fix attempt(s).`);
    renderCurrentState(stepPanel);
    return;
  }

  agentPipelineState.lintFixCount = lintFixCount + 1;

  events.push({
    id: `lint:fix:${Date.now()}:attempt-${lintFixCount + 1}`,
    title: `Lint fix iteration ${lintFixCount + 1}/${maxIterations}`,
    status: "running",
    tool: "agent_coder",
    summary: `Sending lint errors back to the coder for fix attempt ${lintFixCount + 1}.`,
    warnings: []
  });

  const plan = agentPipelineState.plan;
  if (plan === undefined || plan.tasks.length === 0) {
    return;
  }

  const task = plan.tasks[agentPipelineState.currentTaskIndex] ?? plan.tasks[plan.tasks.length - 1]!;
  const context = await createWorkspaceContextSummary(agentPipelineState.rawTask, currentPlanMentionedFiles);

  agentPipelineState.phase = "coding";
  renderCurrentState(stepPanel);

  const lintFeedbackTask: AgentPlanTask = {
    ...task,
    id: `${task.id}_lint_fix_${lintFixCount + 1}`,
    title: `Fix lint errors: ${task.title}`,
    instructions: [
      task.instructions,
      "",
      "IMPORTANT: Your previous patch introduced lint errors. Fix ALL of these errors.",
      `Lint command: ${lintResult.command}`,
      "Lint output:",
      lintResult.output.slice(0, 6000)
    ].join("\n")
  };

  const coderResult = await runCoderReviewLoop(lintFeedbackTask, context, stepPanel, { review: false });
  if (coderResult === undefined) {
    return;
  }
  agentPipelineState.coderResults.push(coderResult);
  queuedPatchApprovals.push(...coderResult.patches.map((patch) => createAgentPatchApproval(lintFeedbackTask, coderResult, patch)));
  pendingApproval = queuedPatchApprovals.shift();
  if (pendingApproval !== undefined) {
    events.push(eventFromPermissionDecision(pendingApproval, "ask"));
  }
  renderCurrentState(stepPanel);
}

async function createValidatedPatches(coderOutput: CoderOutput, snapshots: AgentFileSnapshot[]): Promise<TextPatch[]> {
  const snapshotByPath = new Map(snapshots.map((snapshot) => [normalizeWorkspacePath(snapshot.path), snapshot]));
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (root === undefined) {
    throw new Error("No workspace folder is open.");
  }

  return coderOutput.diffs.map((diff) => {
    const relativePath = normalizeWorkspacePath(diff.path);
    const snapshot = snapshotByPath.get(relativePath);
    if (snapshot === undefined) {
      throw new Error(`Coder returned a diff for unassigned file ${diff.path}.`);
    }
    const absolute = resolve(root, relativePath);
    if (!isWorkspaceRelativePath(root, absolute)) {
      throw new Error(`Coder returned an out-of-workspace path ${diff.path}.`);
    }
    return createTextPatchFromAgentDiff(snapshot.content, { ...diff, path: relativePath }, absolute);
  });
}

function createAgentPatchApproval(task: AgentPlanTask, result: AgentCoderPipelineResult, patch: TextPatch): PendingApproval<TextPatch> {
  const diff = formatPatchForWorkspace(patch);
  return {
    id: `approval:agent_apply_patch:${Date.now()}:${task.id}:${patch.path}`,
    title: `Apply ${task.title}`,
    tool: "apply_patch",
    target: patch.path,
    risk: "high",
    details: [
      result.output.summary,
      "",
      `Task: ${task.title}`,
      `Attempt: ${result.attempt}`,
      "",
      diff
    ].join("\n"),
    payload: patch
  };
}

function formatPatchForWorkspace(patch: TextPatch): string {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (root === undefined) {
    return formatTextPatchAsGitDiff(patch);
  }
  const displayPath = normalizeWorkspacePath(relative(root, patch.path));
  return formatTextPatchAsGitDiff({ ...patch, path: displayPath });
}

async function queueAgentTestGeneration(stepPanel: StepPanel): Promise<void> {
  if (agentPipelineState?.plan === undefined) {
    return;
  }
  agentPipelineState.phase = "testing";
  const tester = await invokeStreamingJsonAgent("tester", "Tester: generating test cases", createTesterMessages({
    requestId: createAgentRequestId("tester"),
    plan: agentPipelineState.plan
  }), validateTesterOutput, stepPanel);
  agentPipelineState.testCases = tester.data.testCases;
  agentPipelineState.warnings.push(...tester.warnings);
  const testerCasesEvidence = lastStreamEvidence();
  events.push({
    id: `agent:tester:cases:${Date.now()}`,
    title: "Tester generated test cases",
    status: tester.data.testCases.length > 0 ? "completed" : "blocked",
    tool: "agent_tester",
    summary: tester.data.testCases.length > 0
      ? `Generated ${tester.data.testCases.length} test case(s).`
      : "Tester did not generate executable test cases.",
    warnings: tester.warnings,
    ...(testerCasesEvidence === undefined ? {} : { evidence: testerCasesEvidence })
  });

  const testCase = tester.data.testCases[0];
  if (testCase === undefined) {
    completeAgentPipeline("No test cases were generated.");
    renderCurrentState(stepPanel, createFinalReportSummary());
    return;
  }

  pendingApproval = createTerminalApproval(testCase.command, testCase.id);
  events.push(eventFromPermissionDecision(pendingApproval, "ask"));
  renderCurrentState(stepPanel);
}

async function inspectAgentTestResults(stepPanel: StepPanel): Promise<void> {
  if (agentPipelineState?.plan === undefined) {
    return;
  }
  const tester = await invokeStreamingJsonAgent("tester", "Tester: inspecting results", createTesterMessages({
    requestId: createAgentRequestId("tester"),
    plan: agentPipelineState.plan,
    observations: agentPipelineState.testObservations
  }), validateTesterOutput, stepPanel);
  const status = tester.data.result?.status ?? (agentPipelineState.testObservations.every((observation) => observation.exitCode === 0) ? "passed" : "failed");
  const failures = tester.data.result?.failures ?? [];
  const testerResultEvidence = lastStreamEvidence();
  events.push({
    id: `agent:tester:result:${Date.now()}`,
    title: "Tester inspected results",
    status: status === "passed" ? "completed" : "failed",
    tool: "agent_tester",
    summary: status === "passed" ? "Tester marked verification as passed." : `Tester marked verification as failed: ${failures.join("; ")}`,
    warnings: tester.warnings,
    ...(testerResultEvidence === undefined ? {} : { evidence: testerResultEvidence })
  });
  completeAgentPipeline(status === "passed" ? "Agent workflow completed." : "Agent workflow completed with failing tests.");
  renderCurrentState(stepPanel, createFinalReportSummary());
}

// Wraps invokeJsonAgent with the live raw-output stream lifecycle so every agent
// role (architect, coder, reviewer, tester) shows its tokens in the step panel.
async function invokeStreamingJsonAgent<TData>(
  role: AgentRole,
  label: string,
  messagesForModel: CoreChatMessage[],
  validateData: (value: unknown) => TData,
  stepPanel: StepPanel
): Promise<AgentJsonEnvelope<TData>> {
  if (agentPipelineState !== undefined) {
    agentPipelineState.activeStream = { role, label, raw: "", active: true };
  }
  stepPanel.postAgentStreamStart(role, label);
  renderCurrentState(stepPanel);
  const onDelta = (content: string): void => {
    if (agentPipelineState?.activeStream !== undefined) {
      agentPipelineState.activeStream.raw += content;
    }
    stepPanel.postAgentStreamDelta(content);
  };
  try {
    return await invokeJsonAgent(role, messagesForModel, validateData, onDelta);
  } finally {
    if (agentPipelineState?.activeStream !== undefined) {
      agentPipelineState.activeStream.active = false;
    }
    stepPanel.postAgentStreamComplete();
  }
}

// Raw model output of the step that just finished streaming, captured so it can
// be attached to that step's execution event and stay visible after the next
// step starts (the live activeStream view is overwritten each step).
function lastStreamEvidence(): { outputExcerpt: string } | undefined {
  const raw = agentPipelineState?.activeStream?.raw.trim();
  return raw === undefined || raw.length === 0 ? undefined : { outputExcerpt: raw.slice(0, 8000) };
}

async function invokeJsonAgent<TData>(
  role: AgentRole,
  messagesForModel: CoreChatMessage[],
  validateData: (value: unknown) => TData,
  onDelta?: (content: string) => void
): Promise<AgentJsonEnvelope<TData>> {
  const requestId = extractAgentRequestId(messagesForModel);
  const rawResponse = await invokeAgentModel(messagesForModel, onDelta);
  try {
    return parseAgentEnvelope(rawResponse, role, requestId, validateData);
  } catch (error) {
    const repairMessages = createAgentRepairMessages({
      role,
      requestId,
      schema: agentDataSchemaDescription(role),
      validationError: error instanceof Error ? error.message : String(error),
      rawResponse
    });
    events.push({
      id: `agent:${role}:repair:${Date.now()}`,
      title: `Repair ${role} JSON`,
      status: "running",
      tool: `agent_${role}`,
      summary: `Invalid ${role} JSON: ${error instanceof Error ? error.message : String(error)}. Asking the model to repair the envelope.`,
      evidence: { outputExcerpt: rawResponse.slice(0, 4000) },
      warnings: []
    });
    const repairedResponse = await invokeAgentModel(repairMessages, onDelta);
    try {
      const repaired = parseAgentEnvelope(repairedResponse, role, requestId, validateData);
      events.push({
        id: `agent:${role}:repair:${Date.now()}:completed`,
        title: `Repair ${role} JSON`,
        status: "completed",
        tool: `agent_${role}`,
        summary: `Repaired ${role} JSON envelope.`,
        warnings: repaired.warnings
      });
      return repaired;
    } catch (repairError) {
      throw new Error([
        `${capitalize(role)} returned invalid JSON after one repair attempt.`,
        `Initial validation error: ${error instanceof Error ? error.message : String(error)}`,
        `Repair validation error: ${repairError instanceof Error ? repairError.message : String(repairError)}`,
        `Initial response excerpt: ${rawResponse.slice(0, 1000)}`,
        `Repair response excerpt: ${repairedResponse.slice(0, 1000)}`
      ].join("\n"));
    }
  }
}

async function invokeAgentModel(
  messagesForModel: CoreChatMessage[],
  onDelta?: (content: string) => void
): Promise<string> {
  const configuredCore = createConfiguredCore();
  const modelId = getConfiguredModelId();
  lastContextTokens = estimateCoreContextTokens(messagesForModel);
  let rawResponse = "";
  for await (const delta of configuredCore.model.chat({
    model: modelId,
    temperature: 0.1,
    messages: messagesForModel
  }, activeAbortController?.signal === undefined ? {} : { signal: activeAbortController.signal })) {
    if (delta.type === "text" && delta.content !== undefined) {
      rawResponse += delta.content;
      onDelta?.(delta.content);
    }
  }
  return rawResponse;
}

function createAgentRepairMessages(options: {
  role: AgentRole;
  requestId: string;
  schema: string;
  validationError: string;
  rawResponse: string;
}): CoreChatMessage[] {
  return [
    {
      role: "system",
      content: [
        `You repair invalid deterministic ${options.role} agent output.`,
        "Return only JSON. Do not wrap the JSON in Markdown.",
        `The corrected envelope must keep role "${options.role}", version 1, requestId "${options.requestId}", status "ok" or "blocked", data, and warnings array.`,
        "Do not add prose. Do not change the requestId. Do not decide routing.",
        "Every value must be valid JSON. Do not use JavaScript expressions or string concatenation inside JSON.",
        "",
        "Required data schema:",
        options.schema
      ].join("\n")
    },
    {
      role: "user",
      content: [
        "The previous response failed validation.",
        `Validation error: ${options.validationError}`,
        "",
        "Previous response:",
        options.rawResponse
      ].join("\n")
    }
  ];
}

function agentDataSchemaDescription(role: AgentRole): string {
  switch (role) {
    case "architect":
      return "{ plan: { summary: string, tasks: [{ id: string, title: string, instructions: string, targetFiles: string[], dependsOn: string[], acceptanceCriteria: string[] }] } }. targetFiles must be concrete workspace-relative paths (e.g. src/snake.js), never descriptions.";
    case "coder":
      return "{ summary: string, diffs: [{ path: string, beforeHash: string, hunks: [{ oldStart: number, oldLines: number, newStart: number, newLines: number, lines: string[] }] }] }. Hunk lines must start with space, +, or -. For new files use oldStart 0 and oldLines 0.";
    case "reviewer":
      return "{ status: 'approved' } or { status: 'changes_needed', issues: [{ category: 'correctness' | 'style' | 'tests', message: string }] }";
    case "tester":
      return "{ testCases: [{ id: string, title: string, command: string }], result?: { status: 'passed' | 'failed', failures: string[] } }";
  }
}

function capitalize(value: string): string {
  return value.length === 0 ? value : `${value[0]!.toUpperCase()}${value.slice(1)}`;
}

function convertAgentPlanToBuildrPlan(goal: string, plan: AgentPlan): BuildrPlan {
  return {
    goal,
    acceptanceCriteria: plan.tasks.flatMap((task) => task.acceptanceCriteria),
    scopeBoundaries: ["Only edit files named by Architect tasks.", "Do not run generated tests without approval."],
    rulePacks: ["agent-behavior", "verification", "git-workflow"],
    verification: {
      required: true,
      levels: ["tests"],
      commands: [],
      allowUnverifiedCompletion: "ask",
      includeOutputEvidence: true
    },
    steps: plan.tasks.map((task) => ({
      id: task.id,
      title: task.title,
      kind: "write" as const,
      tools: ["agent_coder", "agent_reviewer", "apply_patch"],
      targets: task.targetFiles,
      dependsOn: task.dependsOn,
      risk: "medium" as const,
      verification: task.acceptanceCriteria
    }))
  };
}

function convertBuildrPlanToAgentPlan(plan: BuildrPlan): AgentPlan {
  return {
    summary: plan.goal,
    tasks: plan.steps.filter((step) => step.kind === "write").map((step) => ({
      id: step.id,
      title: step.title,
      instructions: [
        step.title,
        step.scopeCheck ?? "",
        ...(step.verification ?? [])
      ].filter((part) => part.length > 0).join("\n"),
      targetFiles: step.targets,
      dependsOn: step.dependsOn,
      acceptanceCriteria: step.verification ?? plan.acceptanceCriteria
    }))
  };
}

async function createWorkspaceTree(): Promise<string[]> {
  const root = vscode.workspace.workspaceFolders?.[0];
  if (root === undefined) {
    return [];
  }
  const files = await vscode.workspace.findFiles(
    new vscode.RelativePattern(root, "**/*"),
    "{**/.git/**,**/.vscode/**,**/node_modules/**,**/dist/**,**/out/**,**/coverage/**,**/.pnpm-store/**}",
    500
  );
  return files.map((uri) => normalizeWorkspacePath(relative(root.uri.fsPath, uri.fsPath))).sort();
}

async function createFileSnapshots(paths: string[]): Promise<AgentFileSnapshot[]> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (root === undefined) {
    return [];
  }
  const unique = [...new Set(paths.map(normalizeWorkspacePath))];
  return Promise.all(unique.map(async (path) => {
    const absolute = resolve(root, path);
    if (!isWorkspaceRelativePath(root, absolute)) {
      throw new Error(`Architect assigned an out-of-workspace path ${path}.`);
    }
    const { content, exists } = await readFileIfPresent(absolute);
    return {
      path,
      content,
      hash: hashText(content),
      exists
    };
  }));
}

function createAgentRequestId(role: AgentRole): string {
  return `${role}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
}

function extractAgentRequestId(messagesForModel: CoreChatMessage[]): string {
  const system = messagesForModel.find((message) => message.role === "system")?.content ?? "";
  const match = /"requestId":"([^"]+)"/u.exec(system);
  if (match === null) {
    throw new Error("Agent request id could not be read from prompt.");
  }
  return match[1]!;
}

function completeAgentPipeline(summary: string): void {
  if (agentPipelineState !== undefined) {
    agentPipelineState.phase = "complete";
    agentPipelineState.finalSummary = summary;
    agentPipelineState.activeStream = undefined;
  }
  messages.push({ role: "assistant", text: summary });
}

function failAgentPipeline(error: unknown): void {
  const summary = error instanceof Error ? error.message : String(error);
  if (agentPipelineState !== undefined) {
    agentPipelineState.phase = "failed";
    agentPipelineState.finalSummary = summary;
    agentPipelineState.warnings.push(summary);
    agentPipelineState.activeStream = undefined;
  }
  events.push({
    id: `agent:failed:${Date.now()}`,
    title: "Agent workflow failed",
    status: "failed",
    tool: "agent_orchestrator",
    summary,
    warnings: []
  });
  messages.push({ role: "assistant", text: summary });
  vscode.window.showErrorMessage(summary);
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

  if (approval.tool === "agent_retry") {
    const continueWorkflow = message.decision === "approve";
    events.push(eventFromPermissionDecision(approval, continueWorkflow ? "allow" : "deny"));
    pendingAgentRetryResolver?.(continueWorkflow);
    pendingAgentRetryResolver = undefined;
    renderCurrentState(stepPanel);
    return;
  }

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

      if (agentPipelineState !== undefined) {
        await runLintAndFixIfNeeded(stepPanel);
        if (pendingApproval !== undefined) {
          return;
        }
      }

      if (agentPipelineState?.verificationMode === "skip") {
        const lintNote = (agentPipelineState.lintFixCount ?? 0) > 0 ? " Lint fixes were applied." : "";
        completeAgentPipeline(`Fast Agent patch applied.${lintNote}`);
        renderCurrentState(stepPanel, createFinalReportSummary());
        return;
      }

      if (agentPipelineState !== undefined && agentPipelineState.phase !== "complete" && agentPipelineState.phase !== "blocked" && agentPipelineState.phase !== "failed") {
        await queueAgentTestGeneration(stepPanel);
        return;
      }

      if (queuedVerificationCommand !== undefined) {
        renderCurrentState(stepPanel, await queueVerificationApproval() === "skipped" ? createFinalReportSummary() : undefined);
        return;
      }
    } else if (approval.tool === "run_terminal") {
      const payload = approval.payload as TerminalApprovalPayload;
      if (payload.agentTestCaseId !== undefined) {
        const result = await runCommandAsVscodeTask(
          payload.command,
          payload.cwd,
          activeAbortController?.signal === undefined ? {} : { signal: activeAbortController.signal }
        );
        agentPipelineState?.testObservations.push({
          id: payload.agentTestCaseId,
          command: result.command,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr
        });
        events.push({
          id: `${approval.id}:completed`,
          title: "Run approved agent test",
          status: result.exitCode === 0 ? "completed" : "failed",
          tool: "vscode_task",
          target: payload.cwd,
          summary: result.timedOut === true
            ? "Task timed out before completing."
            : `Task exited with ${result.exitCode ?? "unknown"}.`,
          evidence: result.exitCode === undefined
            ? {
              command: result.command,
              outputExcerpt: [result.stdout, result.stderr].filter((part) => part.length > 0).join("\n").slice(-4000)
            }
            : {
              command: result.command,
              exitCode: result.exitCode,
              outputExcerpt: [result.stdout, result.stderr].filter((part) => part.length > 0).join("\n").slice(-4000)
            },
          warnings: result.timedOut === true ? ["Approved agent test command timed out. Avoid watch/dev-server commands for verification."] : []
        });
        const nextTestCase = agentPipelineState?.testCases.find((testCase) => !agentPipelineState?.testObservations.some((observation) => observation.id === testCase.id));
        if (nextTestCase !== undefined) {
          pendingApproval = createTerminalApproval(nextTestCase.command, nextTestCase.id);
          events.push(eventFromPermissionDecision(pendingApproval, "ask"));
          renderCurrentState(stepPanel);
          return;
        }
        await inspectAgentTestResults(stepPanel);
        return;
      }
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

  if (!await ensureCloudProviderReady("send the active file to the configured provider")) {
    return undefined;
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
  if (!await ensureCloudProviderReady("create patch proposals with workspace context")) {
    return [];
  }
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
    summary: `Ran ${report.subAgents.length} sub-agent(s); received ${report.patchProposals.length} patch proposal(s). ${formatTokenBudgetSummary(report.tokenBudget)}`,
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
  if (!await ensureCloudProviderReady("create a patch proposal with workspace context")) {
    throw new Error("Buildr did not send workspace context to the configured cloud provider.");
  }
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
    trimmed.endsWith("/") ||
    // Reject plan steps whose target is a description rather than a real path
    // (e.g. "associated style file(s)"); otherwise Buildr creates files named
    // after the description and writes incomplete content into them.
    !isPlausibleWorkspacePath(normalizeWorkspacePath(trimmed))
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

async function readFileIfPresent(path: string): Promise<{ content: string; exists: boolean }> {
  try {
    return { content: await readFile(path, "utf8"), exists: true };
  } catch {
    return { content: "", exists: false };
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

function createTerminalApproval(command: string, agentTestCaseId?: string): PendingApproval<TerminalApprovalPayload> {
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  return {
    id: `approval:run_terminal:${Date.now()}`,
    title: agentTestCaseId === undefined ? "Run verification command" : "Run agent test task",
    tool: "run_terminal",
    target: cwd,
    risk: "medium",
    details: `Command: ${command}\nCwd: ${cwd}\nTimeout: 120000ms`,
    payload: agentTestCaseId === undefined ? { command, cwd } : { command, cwd, agentTestCaseId }
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

function renderCurrentState(stepPanel: StepPanel, finalSummary?: string, options: { reveal?: boolean } = {}): void {
  if (finalSummary !== undefined) {
    finalSummaryState = finalSummary;
  }
  void refreshContextWindow(stepPanel);
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
    ...(agentPipelineState === undefined ? {} : { agentPipeline: agentPipelineState }),
    model: getConfiguredModelState(),
    contextSize: getContextSize(),
    ...(finalSummaryState === undefined ? {} : { finalSummary: finalSummaryState }),
    activeSessionId,
    sessions: getSessionSummaries()
  };
  stepPanel.showState(state, options);
}

function estimateContextTokens(msgs: ChatMessage[]): number {
  const totalChars = msgs.reduce((sum, message) => sum + message.text.length, 0);
  return Math.ceil(totalChars / 4);
}

function estimateCoreContextTokens(msgs: CoreChatMessage[]): number {
  const totalChars = msgs.reduce((sum, message) => sum + message.content.length, 0);
  return Math.ceil(totalChars / 4);
}

function getContextSize(): { approxTokens: number; contextWindow?: number } {
  // Report the real prompt/context-window size sent on the last model call. Fall
  // back to the transcript estimate only before any call has been made this
  // session (e.g. a fresh, idle composer).
  const approxTokens = lastContextTokens ?? estimateContextTokens(messages);
  return contextWindowTokens === undefined ? { approxTokens } : { approxTokens, contextWindow: contextWindowTokens };
}

// Resolves the active model's context window once per provider/model/baseUrl and
// caches it. The lookup is provider-specific (real query where supported,
// otherwise the adapter's recommended capability), so it runs off the render
// path and re-renders when the value arrives.
async function refreshContextWindow(stepPanel: StepPanel): Promise<void> {
  const { provider, baseUrl } = getConfiguredProviderAndBaseUrl();
  const modelId = getConfiguredModelId();
  const key = `${provider}|${baseUrl}|${modelId}`;
  if (key === contextWindowKey) {
    return;
  }
  contextWindowKey = key;

  let resolved: number | undefined;
  try {
    const adapter = createConfiguredCore().model;
    if (adapter.getContextWindow !== undefined) {
      resolved = await adapter.getContextWindow(modelId);
    }
    if (resolved === undefined) {
      const capabilities = await adapter.getCapabilities(modelId);
      resolved = capabilities.maxContextTokens ?? capabilities.recommendedContextTokens;
    }
  } catch {
    resolved = undefined;
  }

  if (contextWindowKey === key) {
    contextWindowTokens = resolved;
    renderCurrentState(stepPanel);
  }
}

function getMaxParallelSubAgents(): number {
  return vscode.workspace.getConfiguration("buildr.agents").get<number>("maxParallelSubAgents", 3);
}

function getConfiguredModelState(): { provider: string; modelId: string; baseUrl: string; local: boolean } {
  const { provider, baseUrl } = getConfiguredProviderAndBaseUrl();
  return {
    provider,
    modelId: getConfiguredModelId(),
    baseUrl,
    local: isLocalProvider(provider, baseUrl)
  };
}

function getTokenBudgetConfig(): TokenBudgetConfig {
  if (isConfiguredLocalModel()) {
    return { unlimited: true };
  }

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

function formatTokenBudgetSummary(state: TokenBudgetState): string {
  if (state.unlimited) {
    return "Token budget unlimited for local model.";
  }
  return `Tokens: ${state.totalTokens}/${state.hardTokenCap}, estimated cost $${state.estimatedCostUsd.toFixed(6)}.`;
}

function isConfiguredLocalModel(): boolean {
  const { provider, baseUrl } = getConfiguredProviderAndBaseUrl();
  return isLocalProvider(provider, baseUrl);
}

function isLocalProvider(provider: ProviderId, baseUrl: string): boolean {
  return provider === "ollama"
    || provider === "lmstudio-openai"
    || provider === "lmstudio-native"
    || isLocalBaseUrl(baseUrl);
}

async function ensureCloudProviderReady(action: string): Promise<boolean> {
  if (isConfiguredLocalModel()) {
    return true;
  }

  const { provider } = getConfiguredProviderAndBaseUrl();
  const secret = await providerSecrets?.getProviderSecret(providerSecretKey(provider));
  if (secret === undefined || secret.length === 0) {
    vscode.window.showWarningMessage(`Buildr needs an API key for ${provider} before it can ${action}. Run Buildr: Configure Model and store a provider secret.`);
    return false;
  }

  const policy = vscode.workspace.getConfiguration("buildr.privacy").get<string>("cloudSendPolicy", "ask");
  if (policy === "never") {
    vscode.window.showWarningMessage(`Buildr privacy policy blocks sending workspace context to ${provider}.`);
    return false;
  }
  if (policy === "allow") {
    return true;
  }

  const approval = await vscode.window.showWarningMessage(
    `Buildr is about to ${action} using ${provider}. This may send workspace context or file contents to a cloud provider.`,
    { modal: true },
    "Send"
  );
  return approval === "Send";
}

function isLocalBaseUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "localhost"
      || hostname === "127.0.0.1"
      || hostname === "::1"
      || hostname.startsWith("192.168.")
      || hostname.startsWith("10.")
      || /^172\.(1[6-9]|2\d|3[0-1])\./u.test(hostname);
  } catch {
    return false;
  }
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
