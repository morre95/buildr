import * as vscode from "vscode";
import type { BuildrPlan, ExecutionEvent, PendingApproval, TokenBudgetState } from "@buildr/core";

export type ApprovalDecision = "approve" | "deny";
export type BuildrChatMode = "ask" | "plan" | "agent" | "debug";

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
}

export class StepPanel {
  private panel: vscode.WebviewPanel | undefined;
  private approvalHandler: ((message: ApprovalMessage) => void) | undefined;
  private promptHandler: ((message: PromptMessage) => void) | undefined;
  private fileSearchHandler: ((message: FileSearchMessage) => void) | undefined;
  private runPlanHandler: (() => void) | undefined;
  private changePlanHandler: (() => void) | undefined;
  private stopHandler: (() => void) | undefined;
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

  onRunPlan(handler: () => void): void {
    this.runPlanHandler = handler;
  }

  onChangePlan(handler: () => void): void {
    this.changePlanHandler = handler;
  }

  onStop(handler: () => void): void {
    this.stopHandler = handler;
  }

  showState(state: StepPanelState): void {
    this.ensurePanel();
    if (this.panel === undefined) {
      return;
    }
    this.panel.webview.html = renderState(state);
    this.panel.reveal(vscode.ViewColumn.Beside);
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

  postEditPrompt(prompt: string): void {
    void this.panel?.webview.postMessage({
      type: "editPrompt",
      prompt
    });
  }

  private ensurePanel(): void {
    this.panel = this.panel ?? vscode.window.createWebviewPanel(
      "buildr.stepPanel",
      "Buildr",
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        localResourceRoots: [this.extensionUri]
      }
    );

    if (this.messageDisposable !== undefined || this.panel === undefined) {
      return;
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

      if (isMessageOfType(message, "runPlan")) {
        this.runPlanHandler?.();
        return;
      }

      if (isMessageOfType(message, "changePlan")) {
        this.changePlanHandler?.();
      }
    });
    this.panel.onDidDispose(() => {
      this.panel = undefined;
      this.messageDisposable?.dispose();
      this.messageDisposable = undefined;
    });
  }
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
  const stream = renderStream(state.stream);
  const tokenBudget = renderTokenBudget(state.tokenBudget);
  const canRunPlan = state.plan !== undefined && !state.running && state.pendingApproval === undefined;
  const plan = renderPlans(state.planHistory, state.plan, canRunPlan, state.running);

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

      .composer {
        border-top: 1px solid var(--vscode-panel-border);
        padding: 10px 12px 12px;
        background: var(--vscode-sideBar-background);
      }

      .toolbar {
        display: flex;
        gap: 8px;
        margin-bottom: 8px;
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
        <h1>Buildr</h1>
      </header>
      <div class="content">
        ${messages}
        ${tokenBudget}
        ${stream}
        ${plan}
        <section><h2>Execution</h2><ol>${events}</ol></section>
        ${pending}
        ${finalSummary}
      </div>
      <form class="composer" id="composer">
        <div class="toolbar">
          <select id="mode" aria-label="Buildr mode">
            ${renderModeOption("ask", "Ask", state.mode)}
            ${renderModeOption("plan", "Plan", state.mode)}
            ${renderModeOption("agent", "Agent", state.mode)}
            ${renderModeOption("debug", "Debug", state.mode)}
          </select>
          <button type="submit" ${state.running ? "disabled" : ""}>Send</button>
          <button type="button" class="secondary" id="stop" ${state.running ? "" : "disabled"}>Stop</button>
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
      let activeMention = undefined;

      document.querySelectorAll("[data-approval]").forEach((button) => {
        button.addEventListener("click", () => {
          vscode.postMessage({
            type: "approval",
            id: button.getAttribute("data-approval-id"),
            decision: button.getAttribute("data-approval")
          });
        });
      });

      document.getElementById("composer").addEventListener("submit", (event) => {
        event.preventDefault();
        const value = prompt.value.trim();
        if (value.length === 0) {
          return;
        }
        vscode.postMessage({
          type: "submitPrompt",
          mode: mode.value,
          prompt: value,
          fileMentions: extractFileMentions(value)
        });
      });

      document.getElementById("stop").addEventListener("click", () => {
        vscode.postMessage({ type: "stop" });
      });

      document.getElementById("run-plan")?.addEventListener("click", () => {
        vscode.postMessage({ type: "runPlan" });
      });

      document.getElementById("change-plan")?.addEventListener("click", () => {
        vscode.postMessage({ type: "changePlan" });
      });

      prompt.addEventListener("input", () => {
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
        if (event.key !== "Escape") {
          return;
        }
        suggestions.hidden = true;
      });

      window.addEventListener("message", (event) => {
        if (event.data?.type === "fileSearchResults") {
          renderSuggestions(event.data.results ?? []);
          return;
        }
        if (event.data?.type === "streamStart") {
          setStreamStatus(event.data.status ?? "Planning started.");
          setStreamRaw("");
          return;
        }
        if (event.data?.type === "streamDelta") {
          appendStreamRaw(event.data.content ?? "");
          return;
        }
        if (event.data?.type === "streamComplete" || event.data?.type === "streamError") {
          setStreamStatus(event.data.status ?? "Planning finished.");
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
        }
      }

      function appendStreamRaw(content) {
        const rawElement = document.getElementById("stream-raw");
        if (rawElement !== null) {
          rawElement.textContent += content;
        }
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

function renderTokenBudget(tokenBudget: TokenBudgetState | undefined): string {
  if (tokenBudget === undefined) {
    return "";
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

function renderPendingApproval(approval: PendingApproval): string {
  return `<section aria-label="Pending approval">
    <h2>Pending Approval</h2>
    <p><strong>${escapeHtml(approval.title)}</strong></p>
    <p>Tool: ${escapeHtml(approval.tool)}</p>
    <p>Target: ${escapeHtml(approval.target ?? "n/a")}</p>
    <pre>${escapeHtml(approval.details)}</pre>
    <button type="button" data-approval="approve" data-approval-id="${escapeHtml(approval.id)}">Approve Once</button>
    <button type="button" class="secondary" data-approval="deny" data-approval-id="${escapeHtml(approval.id)}">Deny</button>
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

  return `<pre>${escapeHtml(rows.join("\n\n"))}</pre>`;
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
  if (message.mode !== "ask" && message.mode !== "plan" && message.mode !== "agent" && message.mode !== "debug") {
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
