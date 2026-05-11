import {
  assessRemoteCompatibility,
  createMcpRegistrySnapshot,
  loadWorkspaceMcpConfig,
  runMcpDoctor
} from "@buildr/core";
import * as vscode from "vscode";

export async function showMcpList(): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (root === undefined) {
    vscode.window.showWarningMessage("Open a workspace folder before listing MCP servers.");
    return;
  }

  const config = await loadWorkspaceMcpConfig(root);
  const snapshot = createMcpRegistrySnapshot(config);
  const lines = [
    ...snapshot.servers.map((server) => `${server.serverName}: ${server.status} (${server.message})`),
    ...snapshot.tools.map((tool) => `tool: ${tool.name} [${tool.permission}]`),
    ...snapshot.warnings.map((warning) => `warning: ${warning}`)
  ];
  vscode.window.showInformationMessage(lines.join("\n") || "No MCP servers configured.");
}

export async function showMcpDoctor(): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (root === undefined) {
    vscode.window.showWarningMessage("Open a workspace folder before running MCP doctor.");
    return;
  }

  const result = runMcpDoctor(createMcpRegistrySnapshot(await loadWorkspaceMcpConfig(root)));
  const modelBaseUrl = vscode.workspace.getConfiguration("buildr.model").get<string>("ollamaBaseUrl");
  const remote = assessRemoteCompatibility({
    isTrusted: vscode.workspace.isTrusted,
    uiKind: vscode.env.uiKind === vscode.UIKind.Web ? "web" : "desktop",
    ...(vscode.env.remoteName === undefined ? {} : { remoteName: vscode.env.remoteName }),
    ...(modelBaseUrl === undefined ? {} : { modelBaseUrl }),
    env: process.env
  });
  const warnings = [...result.warnings, ...remote.checks.filter((check) => !check.ok).map((check) => check.message)];
  const message = warnings.length > 0 ? `${result.summary}\n${remote.summary}\n${warnings.join("\n")}` : `${result.summary}\n${remote.summary}`;
  vscode.window.showInformationMessage(message);
}
