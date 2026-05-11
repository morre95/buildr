import * as vscode from "vscode";
import type { BuildrPlan, ExecutionEvent, PendingApproval } from "@buildr/core";

export type ApprovalDecision = "approve" | "deny";

export interface ApprovalMessage {
  id: string;
  decision: ApprovalDecision;
}

export interface StepPanelState {
  plan: BuildrPlan;
  events: ExecutionEvent[];
  pendingApproval?: PendingApproval;
  finalSummary?: string;
}

export class StepPanel {
  private panel: vscode.WebviewPanel | undefined;
  private approvalHandler: ((message: ApprovalMessage) => void) | undefined;
  private messageDisposable: vscode.Disposable | undefined;

  constructor(private readonly extensionUri: vscode.Uri) {}

  onApproval(handler: (message: ApprovalMessage) => void): void {
    this.approvalHandler = handler;
  }

  showState(state: StepPanelState): void {
    this.panel = this.panel ?? vscode.window.createWebviewPanel(
      "buildr.stepPanel",
      "Buildr",
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        localResourceRoots: [this.extensionUri]
      }
    );

    if (this.messageDisposable === undefined) {
      this.messageDisposable = this.panel.webview.onDidReceiveMessage((message: unknown) => {
        const approval = parseApprovalMessage(message);
        if (approval !== undefined) {
          this.approvalHandler?.(approval);
        }
      });
      this.panel.onDidDispose(() => {
        this.panel = undefined;
        this.messageDisposable?.dispose();
        this.messageDisposable = undefined;
      });
    }

    this.panel.webview.html = renderState(state);
    this.panel.reveal(vscode.ViewColumn.Beside);
  }
}

function renderState(state: StepPanelState): string {
  const nonce = createNonce();
  const steps = state.plan.steps
    .map((step) => `<li><strong>${escapeHtml(step.title)}</strong> <span>(${escapeHtml(step.kind)})</span><br><small>depends on: ${escapeHtml(step.dependsOn.join(", ") || "none")} · targets: ${escapeHtml(step.targets.join(", "))}</small></li>`)
    .join("");
  const events = state.events
    .map((event) => `<li><strong>${escapeHtml(event.title)}</strong>: ${escapeHtml(event.summary)} <span>(${escapeHtml(event.status)})</span>${renderEvidence(event)}</li>`)
    .join("");
  const pending = state.pendingApproval === undefined ? "" : renderPendingApproval(state.pendingApproval);
  const finalSummary = state.finalSummary === undefined ? "" : `<h2>Final Report</h2><p>${escapeHtml(state.finalSummary)}</p>`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Buildr Plan</title>
  </head>
  <body>
    <main>
      <h1>Buildr Plan</h1>
      <p>${escapeHtml(state.plan.goal)}</p>
      <h2>Steps</h2>
      <ol>${steps}</ol>
      <h2>Execution</h2>
      <ol>${events}</ol>
      ${pending}
      ${finalSummary}
    </main>
    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      document.querySelectorAll("[data-approval]").forEach((button) => {
        button.addEventListener("click", () => {
          vscode.postMessage({
            type: "approval",
            id: button.getAttribute("data-approval-id"),
            decision: button.getAttribute("data-approval")
          });
        });
      });
    </script>
  </body>
</html>`;
}

function renderPendingApproval(approval: PendingApproval): string {
  return `<section aria-label="Pending approval">
    <h2>Pending Approval</h2>
    <p><strong>${escapeHtml(approval.title)}</strong></p>
    <p>Tool: ${escapeHtml(approval.tool)}</p>
    <p>Target: ${escapeHtml(approval.target ?? "n/a")}</p>
    <pre>${escapeHtml(approval.details)}</pre>
    <button type="button" data-approval="approve" data-approval-id="${escapeHtml(approval.id)}">Approve Once</button>
    <button type="button" data-approval="deny" data-approval-id="${escapeHtml(approval.id)}">Deny</button>
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
  if (typeof message !== "object" || message === null || Array.isArray(message)) {
    return undefined;
  }
  const record = message as Record<string, unknown>;
  if (record.type !== "approval" || typeof record.id !== "string") {
    return undefined;
  }
  if (record.decision !== "approve" && record.decision !== "deny") {
    return undefined;
  }
  return {
    id: record.id,
    decision: record.decision
  };
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
