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

export interface ProviderStatusEntry {
  provider: string;
  kind: "cloud" | "local";
  /** Cloud: an API key is stored. Local: the server is reachable. */
  configured: boolean;
  /** Whether this is the currently selected provider. */
  active: boolean;
  detail: string;
}

export interface ModelProviderStatus {
  active: string;
  entries: ProviderStatusEntry[];
}

export async function showMcpDoctor(providerStatus?: ModelProviderStatus): Promise<void> {
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
    renderProviderStatus(providerStatus),
    `<h2>MCP health</h2>`,
    `<p><span class="status ${result.ok ? "status-ok" : "status-error"}">${result.ok ? "OK" : "Issues found"}</span> — ${escapeHtml(result.summary)}</p>`,
    renderWarnings(result.warnings),
    `<h2>Remote compatibility</h2>`,
    `<p>${escapeHtml(remote.summary)}</p>`,
    renderRemoteChecks(remote.checks)
  ].join("\n");
  showMcpWebview("Buildr: MCP Doctor", body);

  if (providerStatus !== undefined) {
    notifyProviderStatus(providerStatus);
  }
}

function hasConfiguredCloud(status: ModelProviderStatus): boolean {
  return status.entries.some((entry) => entry.kind === "cloud" && entry.configured);
}

function hasRunningLocal(status: ModelProviderStatus): boolean {
  return status.entries.some((entry) => entry.kind === "local" && entry.configured);
}

function notifyProviderStatus(status: ModelProviderStatus): void {
  const cloud = hasConfiguredCloud(status);
  const local = hasRunningLocal(status);
  if (!cloud && !local) {
    vscode.window.showWarningMessage(
      "Buildr: no models to run — no cloud provider has an API key and no local provider is running. The extension is unusable until you add one. Run Buildr: Configure Model."
    );
    return;
  }

  const active = status.entries.find((entry) => entry.active);
  if (active?.kind === "cloud" && !active.configured) {
    vscode.window.showWarningMessage(
      `Buildr: no API key configured for the active cloud provider "${active.provider}". Run Buildr: Configure Model to store one.`
    );
    return;
  }

  if (cloud && !local) {
    vscode.window.showInformationMessage(
      "Buildr: only cloud providers are configured; no local provider is running."
    );
  }
}

function renderProviderStatus(status: ModelProviderStatus | undefined): string {
  if (status === undefined) {
    return "";
  }

  const list = status.entries.length === 0
    ? `<p class="empty">No model providers configured.</p>`
    : `<ul>${status.entries.map(renderProviderEntry).join("\n")}</ul>`;

  return [
    `<h2>Model providers</h2>`,
    list,
    renderProviderAdvisory(hasConfiguredCloud(status), hasRunningLocal(status))
  ].join("\n");
}

function renderProviderEntry(entry: ProviderStatusEntry): string {
  const statusClass = entry.configured ? "status-ok" : "status-error";
  const activeMarker = entry.active ? " <strong>(active)</strong>" : "";
  return `<li><span class="status ${statusClass}">${entry.kind}</span> <code>${escapeHtml(entry.provider)}</code>${activeMarker} — ${escapeHtml(entry.detail)}</li>`;
}

function renderProviderAdvisory(cloud: boolean, local: boolean): string {
  if (!cloud && !local) {
    return `<p class="status-error"><strong>No models to run.</strong> No cloud provider is configured and no local provider is running, so Buildr cannot run any model — the extension is unusable. Run <strong>Buildr: Configure Model</strong> to add a provider.</p>`;
  }
  if (cloud && !local) {
    return `<p class="status-warn">Only cloud providers are configured. No local provider is running, so every request will be sent to a cloud provider.</p>`;
  }
  return "";
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
