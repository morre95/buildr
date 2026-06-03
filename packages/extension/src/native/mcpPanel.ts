import * as vscode from "vscode";
import { escapeHtml } from "../webview/html.js";

// Single reused panel so repeated MCP List / Doctor runs update one tab instead
// of stacking new editors.
let panel: vscode.WebviewPanel | undefined;

export function showMcpWebview(title: string, bodyHtml: string): void {
  if (panel === undefined) {
    panel = vscode.window.createWebviewPanel(
      "buildr.mcpOutput",
      title,
      vscode.ViewColumn.Active,
      { enableScripts: false, retainContextWhenHidden: true }
    );
    panel.onDidDispose(() => {
      panel = undefined;
    });
  }
  panel.title = title;
  panel.webview.html = renderDocument(title, bodyHtml);
  panel.reveal(panel.viewColumn ?? vscode.ViewColumn.Active, false);
}

function renderDocument(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <style>
      :root { color-scheme: light dark; }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        padding: 16px 20px;
        color: var(--vscode-foreground);
        background: var(--vscode-editor-background);
        font-family: var(--vscode-font-family);
        font-size: var(--vscode-font-size);
        line-height: 1.5;
      }
      h1 { font-size: 1.3em; margin: 0 0 4px; }
      h2 { font-size: 1.05em; margin: 20px 0 8px; }
      p.subtitle { color: var(--vscode-descriptionForeground); margin: 0 0 12px; }
      ul { margin: 0; padding-left: 18px; }
      li { margin: 4px 0; }
      code {
        font-family: var(--vscode-editor-font-family, monospace);
        background: var(--vscode-textBlockQuote-background);
        padding: 1px 5px;
        border-radius: 4px;
      }
      .empty { color: var(--vscode-descriptionForeground); font-style: italic; }
      .status { font-weight: 600; }
      .status-ok { color: var(--vscode-charts-green, var(--vscode-testing-iconPassed)); }
      .status-warn { color: var(--vscode-charts-yellow, var(--vscode-editorWarning-foreground)); }
      .status-error { color: var(--vscode-charts-red, var(--vscode-editorError-foreground)); }
      .perm {
        font-size: 0.85em;
        color: var(--vscode-descriptionForeground);
        margin-left: 6px;
      }
    </style>
  </head>
  <body>
    <h1>${escapeHtml(title)}</h1>
    ${bodyHtml}
  </body>
</html>`;
}
