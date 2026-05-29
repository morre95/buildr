import * as vscode from "vscode";
import type { BuildrPlan, ExecutionEvent, PendingApproval, TokenBudgetState } from "@buildr/core";

export type ApprovalDecision = "approve" | "deny";
export type BuildrChatMode = "ask" | "plan" | "fast-agent" | "agent" | "debug";

export interface ApprovalMessage {
  id: string;
  decision: ApprovalDecision;
}

export interface PromptMessage {
  mode: BuildrChatMode;
  prompt: string;
  fileMentions: string[];
}

export interface FileSearchMessage {
  query: string;
}

export interface SavedAgentSessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  text: string;
}

export interface PlanStreamState {
  active: boolean;
  status: string;
  raw: string;
}

export interface PlanHistoryEntry {
  id: string;
  prompt: string;
  plan: BuildrPlan;
  stream?: PlanStreamState;
  createdAt: string;
  warnings: string[];
}

export interface StepPanelState {
  plan?: BuildrPlan;
  planHistory: PlanHistoryEntry[];
  events: ExecutionEvent[];
  pendingApproval?: PendingApproval;
  finalSummary?: string;
  mode: BuildrChatMode;
  running: boolean;
  messages: ChatMessage[];
  activePrompt?: string;
  stream?: PlanStreamState;
  tokenBudget?: TokenBudgetState;
  agentPipeline?: WebviewAgentPipelineState;
  model?: WebviewModelState;
  contextSize?: { approxTokens: number; hardTokenCap?: number };
  activeSessionId?: string;
  sessions?: SavedAgentSessionSummary[];
}

export interface WebviewModelState {
  provider: string;
  modelId: string;
  baseUrl: string;
  local: boolean;
}

export interface WebviewAgentPipelineState {
  phase: string;
  currentTaskIndex: number;
  plan?: {
    summary: string;
    tasks: Array<{ id: string; title: string }>;
  };
  coderResults: Array<{ taskId: string; attempt: number; formattedDiff: string }>;
  reviewResults: Array<{ taskId: string; status: string; issues: string[] }>;
  testCases: Array<{ id: string; title: string; command: string }>;
  finalSummary?: string;
  warnings: string[];
  activeStream?: {
    role: string;
    label: string;
    raw: string;
    active: boolean;
  } | undefined;
}

export class StepPanel {
  private panel: vscode.WebviewPanel | undefined;
  private approvalHandler: ((message: ApprovalMessage) => void) | undefined;
  private promptHandler: ((message: PromptMessage) => void) | undefined;
  private fileSearchHandler: ((message: FileSearchMessage) => void) | undefined;
  private openSessionHandler: ((id: string) => void) | undefined;
  private deleteSessionHandler: ((id: string) => void) | undefined;
  private newSessionHandler: (() => void) | undefined;
  private runPlanHandler: (() => void) | undefined;
  private runPlanFastHandler: (() => void) | undefined;
  private changePlanHandler: (() => void) | undefined;
  private stopHandler: (() => void) | undefined;
  private compactHandler: (() => void) | undefined;
  private disposeHandler: (() => void) | undefined;
  private messageDisposable: vscode.Disposable | undefined;

  constructor(private readonly extensionUri: vscode.Uri) {}

  onApproval(handler: (message: ApprovalMessage) => void): void {
    this.approvalHandler = handler;
  }

  onPrompt(handler: (message: PromptMessage) => void): void {
    this.promptHandler = handler;
  }

  onFileSearch(handler: (message: FileSearchMessage) => void): void {
    this.fileSearchHandler = handler;
  }

  onOpenSession(handler: (id: string) => void): void {
    this.openSessionHandler = handler;
  }

  onDeleteSession(handler: (id: string) => void): void {
    this.deleteSessionHandler = handler;
  }

  onNewSession(handler: () => void): void {
    this.newSessionHandler = handler;
  }

  onRunPlan(handler: () => void): void {
    this.runPlanHandler = handler;
  }

  onRunPlanFast(handler: () => void): void {
    this.runPlanFastHandler = handler;
  }

  onChangePlan(handler: () => void): void {
    this.changePlanHandler = handler;
  }

  onStop(handler: () => void): void {
    this.stopHandler = handler;
  }

  onCompact(handler: () => void): void {
    this.compactHandler = handler;
  }

  onDispose(handler: () => void): void {
    this.disposeHandler = handler;
  }

  showState(state: StepPanelState, options: { reveal?: boolean } = {}): void {
    const created = this.ensurePanel();
    if (this.panel === undefined) {
      return;
    }
    if (created) {
      this.panel.webview.html = renderState(state);
    } else {
      void this.panel.webview.postMessage({
        type: "stateUpdate",
        sections: renderStateSections(state)
      });
    }
    if (created || options.reveal === true) {
      this.panel.reveal(vscode.ViewColumn.Beside);
    }
  }

  postFileSearchResults(results: string[]): void {
    void this.panel?.webview.postMessage({
      type: "fileSearchResults",
      results
    });
  }

  postStreamStart(status: string): void {
    void this.panel?.webview.postMessage({
      type: "streamStart",
      status
    });
  }

  postStreamDelta(content: string): void {
    void this.panel?.webview.postMessage({
      type: "streamDelta",
      content
    });
  }

  postStreamComplete(status: string): void {
    void this.panel?.webview.postMessage({
      type: "streamComplete",
      status
    });
  }

  postStreamError(status: string): void {
    void this.panel?.webview.postMessage({
      type: "streamError",
      status
    });
  }

  postAgentStreamStart(role: string, label: string): void {
    void this.panel?.webview.postMessage({
      type: "agentStreamStart",
      role,
      label
    });
  }

  postAgentStreamDelta(content: string): void {
    void this.panel?.webview.postMessage({
      type: "agentStreamDelta",
      content
    });
  }

  postAgentStreamComplete(): void {
    void this.panel?.webview.postMessage({
      type: "agentStreamComplete"
    });
  }

  postEditPrompt(prompt: string): void {
    void this.panel?.webview.postMessage({
      type: "editPrompt",
      prompt
    });
  }

  private ensurePanel(): boolean {
    let created = false;
    if (this.panel === undefined) {
      this.panel = vscode.window.createWebviewPanel(
        "buildr.stepPanel",
        "Buildr",
        vscode.ViewColumn.Beside,
        {
          enableScripts: true,
          localResourceRoots: [this.extensionUri]
        }
      );
      created = true;
    }

    if (this.messageDisposable !== undefined || this.panel === undefined) {
      return created;
    }

    this.messageDisposable = this.panel.webview.onDidReceiveMessage((message: unknown) => {
      const approval = parseApprovalMessage(message);
      if (approval !== undefined) {
        this.approvalHandler?.(approval);
        return;
      }

      const prompt = parsePromptMessage(message);
      if (prompt !== undefined) {
        this.promptHandler?.(prompt);
        return;
      }

      const fileSearch = parseFileSearchMessage(message);
      if (fileSearch !== undefined) {
        this.fileSearchHandler?.(fileSearch);
        return;
      }

      if (isMessageOfType(message, "stop")) {
        this.stopHandler?.();
        return;
      }

      if (isMessageOfType(message, "compactContext")) {
        this.compactHandler?.();
        return;
      }

      if (isMessageOfType(message, "runPlan")) {
        this.runPlanHandler?.();
        return;
      }

      if (isMessageOfType(message, "runPlanFast")) {
        this.runPlanFastHandler?.();
        return;
      }

      if (isMessageOfType(message, "changePlan")) {
        this.changePlanHandler?.();
        return;
      }

      const openSession = parseOpenSessionMessage(message);
      if (openSession !== undefined) {
        this.openSessionHandler?.(openSession);
        return;
      }

      const deleteSession = parseDeleteSessionMessage(message);
      if (deleteSession !== undefined) {
        this.deleteSessionHandler?.(deleteSession);
        return;
      }

      if (isMessageOfType(message, "newSession")) {
        this.newSessionHandler?.();
      }
    });
    this.panel.onDidDispose(() => {
      this.disposeHandler?.();
      this.panel = undefined;
      this.messageDisposable?.dispose();
      this.messageDisposable = undefined;
    });
    return created;
  }
}

interface StateSections {
  content: string;
  activity: string;
  running: boolean;
  mode: BuildrChatMode;
  model: string;
  contextSize: string;
  sessions: string;
}

function renderStateSections(state: StepPanelState): StateSections {
  const events = state.events
    .map((event) => `<li><strong>${escapeHtml(event.title)}</strong>: ${escapeHtml(event.summary)} <span>(${escapeHtml(event.status)})</span>${renderEvidence(event)}</li>`)
    .join("");
  const messages = state.messages
    .map((message) => `<article class="message ${escapeHtml(message.role)}"><strong>${escapeHtml(message.role)}</strong><p>${escapeHtml(message.text)}</p></article>`)
    .join("");
  const pending = state.pendingApproval === undefined ? "" : renderPendingApproval(state.pendingApproval);
  const finalSummary = state.finalSummary === undefined ? "" : `<section><h2>Final Report</h2><p>${escapeHtml(state.finalSummary)}</p></section>`;
  const stream = renderStream(state.stream);
  const tokenBudget = renderTokenBudget(state.tokenBudget);
  const agentPipeline = renderAgentPipeline(state.agentPipeline);
  const canRunPlan = state.plan !== undefined && !state.running && state.pendingApproval === undefined;
  const plan = renderPlans(state.planHistory, state.plan, canRunPlan, state.running);

  return {
    content: `${messages}${tokenBudget}${agentPipeline}${stream}${plan}<section><h2>Execution</h2><ol>${events}</ol></section>${pending}${finalSummary}`,
    activity: renderActivity(state),
    running: state.running,
    mode: state.mode,
    model: renderModelState(state.model),
    contextSize: renderContextSize(state.contextSize),
    sessions: renderSessionControls(state.sessions ?? [], state.activeSessionId)
  };
}

function renderState(state: StepPanelState): string {
  const nonce = createNonce();
  const events = state.events
    .map((event) => `<li><strong>${escapeHtml(event.title)}</strong>: ${escapeHtml(event.summary)} <span>(${escapeHtml(event.status)})</span>${renderEvidence(event)}</li>`)
    .join("");
  const messages = state.messages
    .map((message) => `<article class="message ${escapeHtml(message.role)}"><strong>${escapeHtml(message.role)}</strong><p>${escapeHtml(message.text)}</p></article>`)
    .join("");
  const pending = state.pendingApproval === undefined ? "" : renderPendingApproval(state.pendingApproval);
  const finalSummary = state.finalSummary === undefined ? "" : `<section><h2>Final Report</h2><p>${escapeHtml(state.finalSummary)}</p></section>`;
  const activity = renderActivity(state);
  const stream = renderStream(state.stream);
  const tokenBudget = renderTokenBudget(state.tokenBudget);
  const agentPipeline = renderAgentPipeline(state.agentPipeline);
  const canRunPlan = state.plan !== undefined && !state.running && state.pendingApproval === undefined;
  const plan = renderPlans(state.planHistory, state.plan, canRunPlan, state.running);
  const sessions = renderSessionControls(state.sessions ?? [], state.activeSessionId);
  const model = renderModelState(state.model);
  const contextSize = renderContextSize(state.contextSize);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Buildr</title>
    <style>
      :root {
        color-scheme: light dark;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        color: var(--vscode-foreground);
        background: var(--vscode-editor-background);
        font-family: var(--vscode-font-family);
        font-size: var(--vscode-font-size);
      }

      main {
        display: grid;
        grid-template-rows: auto 1fr auto;
        min-height: 100vh;
      }

      header {
        border-bottom: 1px solid var(--vscode-panel-border);
        padding: 12px 16px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }

      .header-left {
        min-width: 0;
      }

      .model-state {
        margin-top: 4px;
        color: var(--vscode-descriptionForeground);
        font-size: 12px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: min(560px, 52vw);
      }

      h1, h2 {
        margin: 0;
        font-weight: 600;
      }

      h1 {
        font-size: 18px;
      }

      h2 {
        font-size: 14px;
        margin-bottom: 8px;
      }

      p {
        margin: 6px 0;
      }

      .content {
        overflow: auto;
        padding: 14px 16px 18px;
      }

      section, .message {
        border-bottom: 1px solid var(--vscode-panel-border);
        padding: 12px 0;
      }

      .activity {
        display: flex;
        align-items: center;
        gap: 10px;
        color: var(--vscode-foreground);
      }

      .composer .activity {
        border-bottom: 0;
        padding: 0 0 10px;
      }

      .activity-spinner {
        width: 14px;
        height: 14px;
        border: 2px solid color-mix(in srgb, var(--vscode-descriptionForeground) 36%, transparent);
        border-top-color: var(--vscode-progressBar-background);
        border-radius: 50%;
        flex: 0 0 auto;
        animation: buildr-spin 0.85s linear infinite;
      }

      .activity-dot {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: var(--vscode-notificationsWarningIcon-foreground);
        flex: 0 0 auto;
      }

      .activity strong {
        display: block;
        font-weight: 600;
      }

      .activity small {
        display: block;
        margin-top: 2px;
      }

      @keyframes buildr-spin {
        to {
          transform: rotate(360deg);
        }
      }

      details.plan-history {
        border-bottom: 1px solid var(--vscode-panel-border);
        padding: 10px 0;
      }

      details.plan-history summary {
        cursor: pointer;
        color: var(--vscode-foreground);
      }

      .message:first-child {
        padding-top: 0;
      }

      .message strong {
        display: block;
        margin-bottom: 4px;
        color: var(--vscode-descriptionForeground);
        text-transform: capitalize;
      }

      ol {
        margin: 8px 0 0;
        padding-left: 22px;
      }

      li {
        margin-bottom: 8px;
      }

      small {
        color: var(--vscode-descriptionForeground);
      }

      pre {
        overflow: auto;
        max-height: 220px;
        padding: 8px;
        background: var(--vscode-textCodeBlock-background);
        border-radius: 4px;
        white-space: pre-wrap;
      }

      .diff {
        overflow: auto;
        max-height: 420px;
        border: 1px solid var(--vscode-panel-border);
        border-radius: 4px;
        background: var(--vscode-textCodeBlock-background);
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: var(--vscode-editor-font-size);
      }

      .diff-line {
        display: grid;
        grid-template-columns: 44px 44px minmax(0, 1fr);
        min-width: max-content;
        white-space: pre;
      }

      .diff-line span {
        padding: 1px 8px;
      }

      .diff-old, .diff-new {
        color: var(--vscode-descriptionForeground);
        text-align: right;
        user-select: none;
        border-right: 1px solid var(--vscode-panel-border);
      }

      .diff-add {
        background: color-mix(in srgb, var(--vscode-gitDecoration-addedResourceForeground) 18%, transparent);
      }

      .diff-remove {
        background: color-mix(in srgb, var(--vscode-gitDecoration-deletedResourceForeground) 18%, transparent);
      }

      .diff-header .diff-code {
        color: var(--vscode-symbolIcon-keywordForeground);
        font-weight: 600;
      }

      .diff-hunk .diff-code {
        color: var(--vscode-editorLineNumber-activeForeground);
      }

      .composer {
        border-top: 1px solid var(--vscode-panel-border);
        padding: 10px 12px 12px;
        background: var(--vscode-sideBar-background);
      }

      .toolbar {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 8px;
      }

      .context-size {
        margin-left: auto;
        font-size: 0.85em;
        color: var(--vscode-descriptionForeground);
        white-space: nowrap;
      }

      .context-size.near-cap {
        color: var(--vscode-errorForeground);
      }

      .session-controls {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
      }

      .section-heading {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }

      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }

      select, textarea, button {
        font: inherit;
      }

      select, textarea {
        color: var(--vscode-input-foreground);
        background: var(--vscode-input-background);
        border: 1px solid var(--vscode-input-border);
      }

      select {
        min-width: 112px;
        height: 28px;
      }

      .session-controls select {
        width: min(360px, 45vw);
      }

      textarea {
        display: block;
        width: 100%;
        min-height: 78px;
        max-height: 180px;
        resize: vertical;
        padding: 8px;
      }

      button {
        height: 28px;
        color: var(--vscode-button-foreground);
        background: var(--vscode-button-background);
        border: 0;
        border-radius: 2px;
        padding: 0 12px;
        cursor: pointer;
      }

      button.secondary {
        color: var(--vscode-button-secondaryForeground);
        background: var(--vscode-button-secondaryBackground);
      }

      button:disabled {
        opacity: 0.6;
        cursor: default;
      }

      .input-wrap {
        position: relative;
      }

      .suggestions {
        position: absolute;
        left: 0;
        right: 0;
        bottom: calc(100% + 4px);
        max-height: 180px;
        overflow: auto;
        border: 1px solid var(--vscode-quickInputList-focusBackground);
        background: var(--vscode-quickInput-background);
        box-shadow: 0 4px 16px rgb(0 0 0 / 28%);
      }

      .suggestions[hidden] {
        display: none;
      }

      .suggestion {
        display: block;
        width: 100%;
        height: auto;
        padding: 6px 8px;
        text-align: left;
        color: var(--vscode-quickInput-foreground);
        background: transparent;
      }

      .suggestion:hover, .suggestion:focus {
        background: var(--vscode-quickInputList-focusBackground);
      }

      .stream-status {
        color: var(--vscode-descriptionForeground);
      }

      .stream-output {
        margin-top: 8px;
      }
    </style>
  </head>
  <body>
    <main>
      <header>
        <div class="header-left">
          <h1>Buildr</h1>
          ${model}
        </div>
        ${sessions}
      </header>
      <div class="content">
        ${messages}
        ${tokenBudget}
        ${agentPipeline}
        ${stream}
        ${plan}
        <section><h2>Execution</h2><ol>${events}</ol></section>
        ${pending}
        ${finalSummary}
      </div>
      <form class="composer" id="composer">
        ${activity}
        <div class="toolbar">
          <select id="mode" aria-label="Buildr mode">
            ${renderModeOption("ask", "Ask", state.mode)}
            ${renderModeOption("plan", "Plan", state.mode)}
            ${renderModeOption("fast-agent", "Fast Agent", state.mode)}
            ${renderModeOption("agent", "Agent", state.mode)}
            ${renderModeOption("debug", "Debug", state.mode)}
          </select>
          <button type="submit" ${state.running ? "disabled" : ""}>Send</button>
          <button type="button" class="secondary" id="stop" ${state.running ? "" : "disabled"}>Stop</button>
          ${contextSize}
        </div>
        <div class="input-wrap">
          <textarea id="prompt" placeholder="Describe the task. Type @ to mention a file." ${state.running ? "disabled" : ""}>${escapeHtml(state.activePrompt ?? "")}</textarea>
          <div class="suggestions" id="suggestions" hidden></div>
        </div>
      </form>
    </main>
    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      const prompt = document.getElementById("prompt");
      const mode = document.getElementById("mode");
      const suggestions = document.getElementById("suggestions");
      const sessionSelect = document.getElementById("session");
      const newSession = document.getElementById("new-session");
      const deleteSession = document.getElementById("delete-session");
      const SLASH_COMMANDS = [{ name: "/compact", description: "Summarize older messages to shrink context" }];
      let activeMention = undefined;
      let activeSlash = undefined;
      scrollContentToLatest();

      document.querySelectorAll("[data-approval]").forEach((button) => {
        button.addEventListener("click", () => {
          vscode.postMessage({
            type: "approval",
            id: button.getAttribute("data-approval-id"),
            decision: button.getAttribute("data-approval")
          });
        });
      });

      const composer = document.getElementById("composer");

      composer.addEventListener("submit", (event) => {
        event.preventDefault();
        const value = prompt.value.trim();
        if (value.length === 0) {
          return;
        }
        if (SLASH_COMMANDS.some((command) => command.name === value)) {
          if (value === "/compact") {
            vscode.postMessage({ type: "compactContext" });
          }
          prompt.value = "";
          activeSlash = undefined;
          suggestions.hidden = true;
          suggestions.replaceChildren();
          return;
        }
        vscode.postMessage({
          type: "submitPrompt",
          mode: mode.value,
          prompt: value,
          fileMentions: extractFileMentions(value)
        });
        prompt.value = "";
        suggestions.hidden = true;
        suggestions.replaceChildren();
      });

      document.getElementById("stop").addEventListener("click", () => {
        vscode.postMessage({ type: "stop" });
      });

      sessionSelect?.addEventListener("change", () => {
        if (sessionSelect.value.length > 0) {
          vscode.postMessage({ type: "openSession", id: sessionSelect.value });
        }
      });

      newSession?.addEventListener("click", () => {
        vscode.postMessage({ type: "newSession" });
      });

      deleteSession?.addEventListener("click", () => {
        if (sessionSelect?.value?.length > 0) {
          vscode.postMessage({ type: "deleteSession", id: sessionSelect.value });
        }
      });

      document.getElementById("run-plan")?.addEventListener("click", () => {
        vscode.postMessage({ type: "runPlan" });
      });

      document.getElementById("run-plan-fast")?.addEventListener("click", () => {
        vscode.postMessage({ type: "runPlanFast" });
      });

      document.getElementById("change-plan")?.addEventListener("click", () => {
        vscode.postMessage({ type: "changePlan" });
      });

      prompt.addEventListener("input", () => {
        activeSlash = findActiveSlash(prompt.value);
        if (activeSlash !== undefined) {
          activeMention = undefined;
          renderSlashSuggestions(activeSlash.query);
          return;
        }
        activeMention = findActiveMention(prompt.value, prompt.selectionStart);
        if (activeMention === undefined) {
          suggestions.hidden = true;
          suggestions.replaceChildren();
          return;
        }
        vscode.postMessage({
          type: "fileSearch",
          query: activeMention.query
        });
      });

      prompt.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
          event.preventDefault();
          composer.requestSubmit();
          return;
        }
        if (event.key === "Escape") {
          suggestions.hidden = true;
        }
      });

      window.addEventListener("message", (event) => {
        if (event.data?.type === "stateUpdate") {
          applyStateUpdate(event.data.sections);
          return;
        }
        if (event.data?.type === "fileSearchResults") {
          renderSuggestions(event.data.results ?? []);
          return;
        }
        if (event.data?.type === "streamStart") {
          setStreamStatus(event.data.status ?? "Planning started.");
          setStreamRaw("");
          scrollContentToLatest();
          return;
        }
        if (event.data?.type === "streamDelta") {
          appendStreamRaw(event.data.content ?? "");
          scrollContentToLatest();
          return;
        }
        if (event.data?.type === "streamComplete" || event.data?.type === "streamError") {
          setStreamStatus(event.data.status ?? "Planning finished.");
          scrollContentToLatest();
          return;
        }
        if (event.data?.type === "agentStreamStart") {
          setAgentStreamLabel(event.data.label ?? "Coder output");
          setAgentStreamRaw("");
          setAgentStreamOpen(true);
          scrollContentToLatest();
          return;
        }
        if (event.data?.type === "agentStreamDelta") {
          appendAgentStreamRaw(event.data.content ?? "");
          scrollContentToLatest();
          return;
        }
        if (event.data?.type === "agentStreamComplete") {
          setAgentStreamOpen(false);
          return;
        }
        if (event.data?.type === "editPrompt") {
          prompt.disabled = false;
          mode.value = "plan";
          prompt.value = event.data.prompt ?? "";
          prompt.focus();
        }
      });

      function setStreamStatus(status) {
        const statusElement = document.getElementById("stream-status");
        if (statusElement !== null) {
          statusElement.textContent = status;
        }
      }

      function setStreamRaw(raw) {
        const rawElement = document.getElementById("stream-raw");
        if (rawElement !== null) {
          rawElement.textContent = raw;
          rawElement.scrollTop = rawElement.scrollHeight;
        }
      }

      function appendStreamRaw(content) {
        const rawElement = document.getElementById("stream-raw");
        if (rawElement !== null) {
          rawElement.textContent += content;
          rawElement.scrollTop = rawElement.scrollHeight;
        }
      }

      function setAgentStreamLabel(label) {
        const el = document.getElementById("agent-stream-label");
        if (el !== null) {
          el.textContent = label;
        }
      }

      function setAgentStreamRaw(raw) {
        const el = document.getElementById("agent-stream-raw");
        if (el !== null) {
          el.textContent = raw;
          el.scrollTop = el.scrollHeight;
        }
      }

      function appendAgentStreamRaw(content) {
        const el = document.getElementById("agent-stream-raw");
        if (el !== null) {
          el.textContent += content;
          el.scrollTop = el.scrollHeight;
        }
      }

      function setAgentStreamOpen(open) {
        const el = document.getElementById("agent-stream-details");
        if (el !== null) {
          el.open = open;
        }
      }

      function scrollContentToLatest() {
        requestAnimationFrame(() => {
          const content = document.querySelector(".content");
          if (content !== null) {
            content.scrollTop = content.scrollHeight;
          }
        });
      }

      function applyStateUpdate(sections) {
        const contentEl = document.querySelector(".content");
        if (contentEl !== null) {
          contentEl.innerHTML = sections.content;
        }

        const composerEl = document.getElementById("composer");
        if (composerEl !== null) {
          const existingActivity = composerEl.querySelector(".activity");
          if (sections.activity) {
            if (existingActivity !== null) {
              existingActivity.outerHTML = sections.activity;
            } else {
              composerEl.insertAdjacentHTML("afterbegin", sections.activity);
            }
          } else if (existingActivity !== null) {
            existingActivity.remove();
          }
        }

        const stopBtn = document.getElementById("stop");
        if (stopBtn !== null) {
          stopBtn.disabled = !sections.running;
        }
        const sendBtn = composerEl?.querySelector("button[type='submit']");
        if (sendBtn !== null) {
          sendBtn.disabled = sections.running;
        }
        prompt.disabled = sections.running;

        if (sections.mode) {
          mode.value = sections.mode;
        }

        const modelEl = document.querySelector(".model-state");
        if (modelEl !== null && sections.model) {
          modelEl.outerHTML = sections.model;
        }

        const contextSizeEl = document.querySelector(".context-size");
        if (contextSizeEl !== null && sections.contextSize) {
          contextSizeEl.outerHTML = sections.contextSize;
        }

        const sessionEl = document.querySelector(".session-controls");
        if (sessionEl !== null && sections.sessions) {
          sessionEl.outerHTML = sections.sessions;
        }

        document.querySelectorAll("[data-approval]").forEach((button) => {
          button.addEventListener("click", () => {
            vscode.postMessage({
              type: "approval",
              id: button.getAttribute("data-approval-id"),
              decision: button.getAttribute("data-approval")
            });
          });
        });

        document.getElementById("run-plan")?.addEventListener("click", () => {
          vscode.postMessage({ type: "runPlan" });
        });
        document.getElementById("run-plan-fast")?.addEventListener("click", () => {
          vscode.postMessage({ type: "runPlanFast" });
        });
        document.getElementById("change-plan")?.addEventListener("click", () => {
          vscode.postMessage({ type: "changePlan" });
        });

        const newSessionBtn = document.getElementById("new-session");
        newSessionBtn?.addEventListener("click", () => {
          vscode.postMessage({ type: "newSession" });
        });
        const deleteSessionBtn = document.getElementById("delete-session");
        deleteSessionBtn?.addEventListener("click", () => {
          const sel = document.getElementById("session");
          if (sel?.value?.length > 0) {
            vscode.postMessage({ type: "deleteSession", id: sel.value });
          }
        });
        const sel = document.getElementById("session");
        sel?.addEventListener("change", () => {
          if (sel.value.length > 0) {
            vscode.postMessage({ type: "openSession", id: sel.value });
          }
        });

        scrollContentToLatest();
      }

      function renderSuggestions(results) {
        suggestions.replaceChildren();
        if (activeMention === undefined || results.length === 0) {
          suggestions.hidden = true;
          return;
        }
        for (const result of results) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "suggestion";
          button.textContent = result;
          button.addEventListener("click", () => {
            const before = prompt.value.slice(0, activeMention.start);
            const after = prompt.value.slice(activeMention.end);
            const inserted = "@" + result;
            prompt.value = before + inserted + after;
            const cursor = before.length + inserted.length;
            prompt.focus();
            prompt.setSelectionRange(cursor, cursor);
            suggestions.hidden = true;
          });
          suggestions.append(button);
        }
        suggestions.hidden = false;
      }

      function renderSlashSuggestions(query) {
        suggestions.replaceChildren();
        const matches = SLASH_COMMANDS.filter((command) => command.name.startsWith("/" + query));
        if (matches.length === 0) {
          suggestions.hidden = true;
          return;
        }
        for (const command of matches) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "suggestion";
          button.textContent = command.name + " — " + command.description;
          button.addEventListener("click", () => {
            prompt.value = command.name;
            activeSlash = undefined;
            prompt.focus();
            prompt.setSelectionRange(command.name.length, command.name.length);
            suggestions.hidden = true;
            suggestions.replaceChildren();
          });
          suggestions.append(button);
        }
        suggestions.hidden = false;
      }

      function findActiveSlash(value) {
        const match = value.match(/^\\/(\\S*)$/);
        if (match === null) {
          return undefined;
        }
        return { query: match[1] ?? "" };
      }

      function findActiveMention(value, cursor) {
        const beforeCursor = value.slice(0, cursor);
        const match = beforeCursor.match(/(^|\\s)@([^\\s@]*)$/);
        if (match === null) {
          return undefined;
        }
        const query = match[2] ?? "";
        const start = cursor - query.length - 1;
        return {
          query,
          start,
          end: cursor
        };
      }

      function extractFileMentions(value) {
        return Array.from(value.matchAll(/(^|\\s)@([^\\s@]+)/g), (match) => match[2]).filter(Boolean);
      }
    </script>
  </body>
</html>`;
}

function renderModeOption(value: BuildrChatMode, label: string, selected: BuildrChatMode): string {
  return `<option value="${value}" ${value === selected ? "selected" : ""}>${label}</option>`;
}

function renderSessionControls(sessions: SavedAgentSessionSummary[], activeSessionId: string | undefined): string {
  const options = sessions
    .map((session) => {
      const label = `${session.title} - ${session.updatedAt}`;
      return `<option value="${escapeHtml(session.id)}" ${session.id === activeSessionId ? "selected" : ""}>${escapeHtml(label)}</option>`;
    })
    .join("");
  return `<div class="session-controls">
    <select id="session" aria-label="Saved Buildr agents">
      ${options}
    </select>
    <button type="button" class="secondary" id="new-session">New</button>
    <button type="button" class="secondary" id="delete-session" ${sessions.length === 0 ? "disabled" : ""}>Delete</button>
  </div>`;
}

function renderModelState(model: WebviewModelState | undefined): string {
  if (model === undefined) {
    return "";
  }
  const budget = model.local ? "local, unlimited tokens" : "cloud, token budget active";
  return `<div class="model-state" title="${escapeHtml(`${model.provider} · ${model.modelId} · ${model.baseUrl}`)}">
    ${escapeHtml(model.provider)} · ${escapeHtml(model.modelId)} · ${escapeHtml(budget)}
  </div>`;
}

function renderActivity(state: StepPanelState): string {
  const pending = state.pendingApproval !== undefined;
  const phase = state.agentPipeline?.phase;
  const agentWorking = phase === "planning" || phase === "coding" || phase === "reviewing" || phase === "linting" || phase === "testing";
  const streamActive = state.stream?.active === true;

  if (!pending && !state.running && !streamActive && !agentWorking) {
    return "";
  }

  const label = pending ? "Waiting for your approval..." : activityLabel(state, phase);
  const detail = pending
    ? state.pendingApproval?.title ?? "Review the pending action below."
    : activityDetail(state, phase);
  const indicator = pending
    ? `<span class="activity-dot" aria-hidden="true"></span>`
    : `<span class="activity-spinner" aria-hidden="true"></span>`;

  return `<div class="activity" role="status" aria-live="polite">
    ${indicator}
    <div>
      <strong>${escapeHtml(label)}</strong>
      <small>${escapeHtml(detail)}</small>
    </div>
  </div>`;
}

function activityLabel(state: StepPanelState, phase: string | undefined): string {
  if (state.stream?.active === true) {
    return "LLM is creating a plan...";
  }
  if (state.running) {
    switch (state.mode) {
      case "ask":
        return "LLM is answering...";
      case "plan":
        return "LLM is planning...";
      case "fast-agent":
        return "LLM is making a fast patch...";
      case "debug":
        return "Debug mode is running...";
      case "agent":
        break;
    }
  }
  switch (phase) {
    case "planning":
      return "LLM is planning the workflow...";
    case "coding":
      return "LLM is writing changes...";
    case "reviewing":
      return "LLM is reviewing changes...";
    case "linting":
      return "Running lint checks...";
    case "testing":
      return "LLM is preparing verification...";
    default:
      return "Buildr is working...";
  }
}

function activityDetail(state: StepPanelState, phase: string | undefined): string {
  if (state.stream?.status !== undefined && state.stream.status.trim().length > 0) {
    return state.stream.status;
  }
  if (state.running && state.mode === "ask") {
    return "Waiting for the model response or tool results.";
  }
  if (state.running && state.mode === "debug") {
    return "Waiting for debug input or analysis.";
  }
  if (state.running && state.mode === "plan") {
    return "Preparing a validated plan.";
  }
  if (state.running && state.mode === "fast-agent" && phase !== "linting") {
    return "Skipping planner, reviewer, and tester for a small change.";
  }
  if (phase === "linting") {
    return "Checking for lint errors in patched files.";
  }
  if (state.agentPipeline?.plan !== undefined && phase !== undefined) {
    const task = state.agentPipeline.plan.tasks[state.agentPipeline.currentTaskIndex];
    if (task !== undefined) {
      return task.title;
    }
  }
  return "Waiting for the model response.";
}

function renderPlans(history: PlanHistoryEntry[], activePlan: BuildrPlan | undefined, canRunPlan: boolean, running: boolean): string {
  const historical = history.map((entry, index) => renderPlanHistory(entry, index + 1)).join("");
  const active = activePlan === undefined
    ? `<section class="empty"><h2>No active plan</h2><p>Describe a task below to start.</p></section>`
    : renderActivePlan(activePlan, history.length + 1, canRunPlan, running);
  return `${historical}${active}`;
}

function renderPlanHistory(entry: PlanHistoryEntry, number: number): string {
  const warnings = entry.warnings.length === 0
    ? ""
    : `<p><small>Warnings: ${escapeHtml(entry.warnings.join("; "))}</small></p>`;
  return `<details class="plan-history">
    <summary>Plan ${number}: ${escapeHtml(entry.plan.goal)}</summary>
    <p><small>${escapeHtml(entry.createdAt)}</small></p>
    <p>${escapeHtml(entry.prompt)}</p>
    ${renderPlanSteps(entry.plan)}
    ${warnings}
    ${renderStream(entry.stream)}
  </details>`;
}

function renderActivePlan(plan: BuildrPlan, number: number, canRunPlan: boolean, running: boolean): string {
  return `<section>
    <div class="section-heading">
      <h2>Plan ${number}</h2>
      <div class="actions">
        <button type="button" id="run-plan" ${canRunPlan ? "" : "disabled"}>Run Plan</button>
        <button type="button" class="secondary" id="run-plan-fast" ${canRunPlan ? "" : "disabled"}>Run Fast</button>
        <button type="button" class="secondary" id="change-plan" ${running ? "disabled" : ""}>Change Plan</button>
      </div>
    </div>
    <p>${escapeHtml(plan.goal)}</p>
    ${renderPlanSteps(plan)}
  </section>`;
}

function renderPlanSteps(plan: BuildrPlan): string {
  const steps = plan.steps
    .map((step) => `<li><strong>${escapeHtml(step.title)}</strong> <span>(${escapeHtml(step.kind)})</span><br><small>depends on: ${escapeHtml(step.dependsOn.join(", ") || "none")} · targets: ${escapeHtml(step.targets.join(", "))}</small></li>`)
    .join("");
  return `<ol>${steps}</ol>`;
}

function renderStream(stream: PlanStreamState | undefined): string {
  if (stream === undefined) {
    return "";
  }
  const status = stream.status;
  const raw = stream.raw;
  return `<section aria-label="Planning stream">
    <h2>Model Stream</h2>
    <p class="stream-status" id="stream-status">${escapeHtml(status)}</p>
    <details class="stream-output" ${stream?.active === true || raw.length > 0 ? "open" : ""}>
      <summary>Raw output</summary>
      <pre id="stream-raw">${escapeHtml(raw)}</pre>
    </details>
  </section>`;
}

function renderContextSize(contextSize: StepPanelState["contextSize"]): string {
  if (contextSize === undefined) {
    return `<span class="context-size"></span>`;
  }
  const cap = contextSize.hardTokenCap;
  const capSuffix = cap === undefined ? "" : ` / ${cap}`;
  const near = cap !== undefined && contextSize.approxTokens >= cap * 0.9 ? " near-cap" : "";
  return `<span class="context-size${near}">Context: ~${contextSize.approxTokens} tokens${escapeHtml(capSuffix)}</span>`;
}

function renderTokenBudget(tokenBudget: TokenBudgetState | undefined): string {
  if (tokenBudget === undefined) {
    return "";
  }
  if (tokenBudget.unlimited) {
    return `<section aria-label="Token budget">
      <h2>Token Budget</h2>
      <p>Unlimited for local model.</p>
    </section>`;
  }
  const cost = tokenBudget.estimatedCostUsd.toFixed(6);
  const approximate = tokenBudget.approximate ? " approximate" : "";
  const warnings = tokenBudget.warnings.length === 0
    ? ""
    : `<pre>${escapeHtml(tokenBudget.warnings.map((warning) => warning.message).join("\n"))}</pre>`;
  const blocked = tokenBudget.blockedReason === undefined
    ? ""
    : `<p><strong>Blocked:</strong> ${escapeHtml(tokenBudget.blockedReason)}</p>`;
  return `<section aria-label="Token budget">
    <h2>Token Budget</h2>
    <p>${tokenBudget.totalTokens}/${tokenBudget.hardTokenCap}${escapeHtml(approximate)} tokens · ${tokenBudget.remainingTokens} remaining · $${escapeHtml(cost)} estimated</p>
    ${blocked}
    ${warnings}
  </section>`;
}

function renderAgentPipeline(agentPipeline: WebviewAgentPipelineState | undefined): string {
  if (agentPipeline === undefined) {
    return "";
  }
  const taskCount = agentPipeline.plan?.tasks.length ?? 0;
  const diffs = agentPipeline.coderResults
    .filter((result) => result.formattedDiff.trim().length > 0)
    .map((result) => `<details class="stream-output"><summary>${escapeHtml(result.taskId)} diff, attempt ${result.attempt}</summary>${renderDiff(result.formattedDiff)}</details>`)
    .join("");
  const reviews = agentPipeline.reviewResults.length === 0
    ? ""
    : `<p><small>Reviews: ${escapeHtml(agentPipeline.reviewResults.map((review) => `${review.taskId}: ${review.status}`).join("; "))}</small></p>`;
  const tests = agentPipeline.testCases.length === 0
    ? ""
    : `<p><small>Tests: ${escapeHtml(agentPipeline.testCases.map((test) => `${test.title}: ${test.command}`).join("; "))}</small></p>`;
  const warnings = agentPipeline.warnings.length === 0
    ? ""
    : `<pre>${escapeHtml(agentPipeline.warnings.join("\n"))}</pre>`;
  const activeStream = agentPipeline.activeStream === undefined
    ? ""
    : `<details id="agent-stream-details" class="stream-output" ${agentPipeline.activeStream.active ? "open" : ""}>
        <summary id="agent-stream-label">${escapeHtml(agentPipeline.activeStream.label)}</summary>
        <pre id="agent-stream-raw">${escapeHtml(agentPipeline.activeStream.raw)}</pre>
      </details>`;
  return `<section aria-label="Agent pipeline">
    <h2>Agent Pipeline</h2>
    <p>Phase: ${escapeHtml(agentPipeline.phase)} · Task ${agentPipeline.currentTaskIndex + 1}/${taskCount}</p>
    ${activeStream}
    ${reviews}
    ${tests}
    ${diffs}
    ${warnings}
  </section>`;
}

function renderPendingApproval(approval: PendingApproval): string {
  const approveLabel = approval.tool === "agent_retry" ? "Continue" : "Approve Once";
  const denyLabel = approval.tool === "agent_retry" ? "Stop" : "Deny";
  const target = approval.tool === "agent_retry" ? "" : `<p>Target: ${escapeHtml(approval.target ?? "n/a")}</p>`;
  return `<section aria-label="Pending approval">
    <h2>Pending Approval</h2>
    <p><strong>${escapeHtml(approval.title)}</strong></p>
    <p>Tool: ${escapeHtml(approval.tool)}</p>
    ${target}
    ${renderDetails(approval.details)}
    <button type="button" data-approval="approve" data-approval-id="${escapeHtml(approval.id)}">${approveLabel}</button>
    <button type="button" class="secondary" data-approval="deny" data-approval-id="${escapeHtml(approval.id)}">${denyLabel}</button>
  </section>`;
}

function renderEvidence(event: ExecutionEvent): string {
  if (event.evidence === undefined && event.warnings.length === 0 && event.target === undefined) {
    return "";
  }

  const evidence = event.evidence;
  const rows = [
    event.tool === undefined ? "" : `Tool: ${event.tool}`,
    event.target === undefined ? "" : `Target: ${event.target}`,
    evidence?.command === undefined ? "" : `Command: ${evidence.command}`,
    evidence?.exitCode === undefined ? "" : `Exit code: ${evidence.exitCode}`,
    evidence?.diagnosticsSummary === undefined ? "" : `Diagnostics: ${evidence.diagnosticsSummary}`,
    evidence?.skippedReason === undefined ? "" : `Skipped: ${evidence.skippedReason}`,
    evidence?.outputExcerpt === undefined ? "" : `Output:\n${evidence.outputExcerpt}`,
    ...event.warnings.map((warning) => `Warning: ${warning}`)
  ].filter((row) => row.length > 0);

  return renderDetails(rows.join("\n\n"));
}

function renderDetails(details: string): string {
  const diffStart = details.indexOf("diff --git ");
  if (diffStart < 0) {
    return `<pre>${escapeHtml(details)}</pre>`;
  }
  const before = details.slice(0, diffStart).trim();
  const diff = details.slice(diffStart);
  return `${before.length === 0 ? "" : `<pre>${escapeHtml(before)}</pre>`}${renderDiff(diff)}`;
}

function renderDiff(diff: string): string {
  let oldLine: number | undefined;
  let newLine: number | undefined;
  const rows = diff.split("\n").map((line) => {
    const hunk = /^@@ -(\d+),?\d* \+(\d+),?\d* @@/u.exec(line);
    if (hunk !== null) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      return renderDiffLine("diff-hunk", "", "", line);
    }
    if (line.startsWith("diff --git ") || line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ")) {
      return renderDiffLine("diff-header", "", "", line);
    }
    if (line.startsWith("+")) {
      const rendered = renderDiffLine("diff-add", "", newLine === undefined ? "" : String(newLine), line);
      newLine = newLine === undefined ? undefined : newLine + 1;
      return rendered;
    }
    if (line.startsWith("-")) {
      const rendered = renderDiffLine("diff-remove", oldLine === undefined ? "" : String(oldLine), "", line);
      oldLine = oldLine === undefined ? undefined : oldLine + 1;
      return rendered;
    }
    const rendered = renderDiffLine("", oldLine === undefined ? "" : String(oldLine), newLine === undefined ? "" : String(newLine), line);
    oldLine = oldLine === undefined ? undefined : oldLine + 1;
    newLine = newLine === undefined ? undefined : newLine + 1;
    return rendered;
  }).join("");
  return `<div class="diff">${rows}</div>`;
}

function renderDiffLine(className: string, oldLine: string, newLine: string, code: string): string {
  return `<div class="diff-line ${className}">
    <span class="diff-old">${escapeHtml(oldLine)}</span>
    <span class="diff-new">${escapeHtml(newLine)}</span>
    <span class="diff-code">${escapeHtml(code)}</span>
  </div>`;
}

function parseApprovalMessage(message: unknown): ApprovalMessage | undefined {
  if (!isRecord(message) || message.type !== "approval" || typeof message.id !== "string") {
    return undefined;
  }
  if (message.decision !== "approve" && message.decision !== "deny") {
    return undefined;
  }
  return {
    id: message.id,
    decision: message.decision
  };
}

function parsePromptMessage(message: unknown): PromptMessage | undefined {
  if (!isRecord(message) || message.type !== "submitPrompt" || typeof message.prompt !== "string") {
    return undefined;
  }
  if (message.mode !== "ask" && message.mode !== "plan" && message.mode !== "fast-agent" && message.mode !== "agent" && message.mode !== "debug") {
    return undefined;
  }
  return {
    mode: message.mode,
    prompt: message.prompt,
    fileMentions: Array.isArray(message.fileMentions)
      ? message.fileMentions.filter((mention): mention is string => typeof mention === "string")
      : []
  };
}

function parseFileSearchMessage(message: unknown): FileSearchMessage | undefined {
  if (!isRecord(message) || message.type !== "fileSearch" || typeof message.query !== "string") {
    return undefined;
  }
  return {
    query: message.query
  };
}

function parseOpenSessionMessage(message: unknown): string | undefined {
  if (!isRecord(message) || message.type !== "openSession" || typeof message.id !== "string") {
    return undefined;
  }
  return message.id;
}

function parseDeleteSessionMessage(message: unknown): string | undefined {
  if (!isRecord(message) || message.type !== "deleteSession" || typeof message.id !== "string") {
    return undefined;
  }
  return message.id;
}

function isMessageOfType(message: unknown, type: string): boolean {
  return isRecord(message) && message.type === type;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let index = 0; index < 32; index += 1) {
    value += chars[Math.floor(Math.random() * chars.length)];
  }
  return value;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
