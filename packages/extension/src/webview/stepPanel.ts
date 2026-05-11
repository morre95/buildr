import * as vscode from "vscode";
import type { BuildrPlan } from "@buildr/core";

export class StepPanel {
  private panel: vscode.WebviewPanel | undefined;

  constructor(private readonly extensionUri: vscode.Uri) {}

  showPlan(plan: BuildrPlan): void {
    this.panel = this.panel ?? vscode.window.createWebviewPanel(
      "buildr.stepPanel",
      "Buildr",
      vscode.ViewColumn.Beside,
      {
        enableScripts: false,
        localResourceRoots: [this.extensionUri]
      }
    );

    this.panel.webview.html = renderPlan(plan);
    this.panel.reveal(vscode.ViewColumn.Beside);
  }
}

function renderPlan(plan: BuildrPlan): string {
  const steps = plan.steps
    .map((step) => `<li><strong>${escapeHtml(step.title)}</strong> <span>(${escapeHtml(step.kind)})</span></li>`)
    .join("");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Buildr Plan</title>
  </head>
  <body>
    <main>
      <h1>Buildr Plan</h1>
      <p>${escapeHtml(plan.goal)}</p>
      <h2>Steps</h2>
      <ol>${steps}</ol>
    </main>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
