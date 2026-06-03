import {
  assessRemoteCompatibility,
  createMcpRegistrySnapshot,
  loadWorkspaceMcpConfig,
  runMcpDoctor,
  type McpServerHealth,
  type RemoteCompatibilityCheck,
  type ToolDefinition
} from "@buildr/core";
import { join } from "node:path";
import * as vscode from "vscode";
import { escapeHtml } from "../webview/html.js";
import { showMcpWebview } from "./mcpPanel.js";
import { fileExists, offerToCreateMcpConfig } from "./mcpTemplates.js";

export async function showMcpList(): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (root === undefined) {
    vscode.window.showWarningMessage("Open a workspace folder before listing MCP servers.");
    return;
  }

  const mcpPath = join(root, ".vscode", "mcp.json");
  if (!(await fileExists(mcpPath))) {
    await offerToCreateMcpConfig(mcpPath);
  }

  const config = await loadWorkspaceMcpConfig(root);
  const snapshot = createMcpRegistrySnapshot(config);
  const body = [
    `<p class="subtitle">Source: <code>${escapeHtml(config.path)}</code></p>`,
    renderServers(snapshot.servers),
    renderTools(snapshot.tools),
    renderWarnings(snapshot.warnings)
  ].join("\n");
  showMcpWebview("Buildr: MCP Servers", body);
}

export async function showMcpDoctor(): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (root === undefined) {
    vscode.window.showWarningMessage("Open a workspace folder before running MCP doctor.");
    return;
  }

  const config = await loadWorkspaceMcpConfig(root);
  const snapshot = createMcpRegistrySnapshot(config);
  const result = runMcpDoctor(snapshot);
  const modelBaseUrl = vscode.workspace.getConfiguration("buildr.model").get<string>("ollamaBaseUrl");
  const remote = assessRemoteCompatibility({
    isTrusted: vscode.workspace.isTrusted,
    uiKind: vscode.env.uiKind === vscode.UIKind.Web ? "web" : "desktop",
    ...(vscode.env.remoteName === undefined ? {} : { remoteName: vscode.env.remoteName }),
    ...(modelBaseUrl === undefined ? {} : { modelBaseUrl }),
    env: process.env
  });

  const body = [
    `<p class="subtitle">Source: <code>${escapeHtml(config.path)}</code></p>`,
    `<h2>MCP health</h2>`,
    `<p><span class="status ${result.ok ? "status-ok" : "status-error"}">${result.ok ? "OK" : "Issues found"}</span> — ${escapeHtml(result.summary)}</p>`,
    renderWarnings(result.warnings),
    `<h2>Remote compatibility</h2>`,
    `<p>${escapeHtml(remote.summary)}</p>`,
    renderRemoteChecks(remote.checks)
  ].join("\n");
  showMcpWebview("Buildr: MCP Doctor", body);
}

function renderServers(servers: McpServerHealth[]): string {
  if (servers.length === 0) {
    return `<h2>Servers</h2><p class="empty">No MCP servers configured.</p>`;
  }
  const items = servers
    .map((server) => `<li><span class="status ${serverStatusClass(server.status)}">${escapeHtml(server.status)}</span> <code>${escapeHtml(server.serverName)}</code> — ${escapeHtml(server.message)}</li>`)
    .join("\n");
  return `<h2>Servers</h2><ul>${items}</ul>`;
}

function renderTools(tools: ToolDefinition[]): string {
  if (tools.length === 0) {
    return `<h2>Tools</h2><p class="empty">No tools mapped from MCP servers.</p>`;
  }
  const items = tools
    .map((tool) => `<li><code>${escapeHtml(tool.name)}</code><span class="perm">[${escapeHtml(tool.permission)}]</span></li>`)
    .join("\n");
  return `<h2>Tools</h2><ul>${items}</ul>`;
}

function renderWarnings(warnings: string[]): string {
  if (warnings.length === 0) {
    return `<h2>Warnings</h2><p class="empty">No warnings.</p>`;
  }
  const items = warnings.map((warning) => `<li class="status-warn">${escapeHtml(warning)}</li>`).join("\n");
  return `<h2>Warnings</h2><ul>${items}</ul>`;
}

function renderRemoteChecks(checks: RemoteCompatibilityCheck[]): string {
  if (checks.length === 0) {
    return `<p class="empty">No remote compatibility checks.</p>`;
  }
  const items = checks
    .map((check) => `<li><span class="status ${checkSeverityClass(check)}">${check.ok ? "ok" : check.severity}</span> ${escapeHtml(check.message)}</li>`)
    .join("\n");
  return `<ul>${items}</ul>`;
}

function serverStatusClass(status: McpServerHealth["status"]): string {
  if (status === "error") {
    return "status-error";
  }
  if (status === "disabled") {
    return "status-warn";
  }
  return "status-ok";
}

function checkSeverityClass(check: RemoteCompatibilityCheck): string {
  if (check.ok) {
    return "status-ok";
  }
  return check.severity === "error" ? "status-error" : "status-warn";
}
