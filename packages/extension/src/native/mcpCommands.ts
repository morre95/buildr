import {
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
  const message = result.warnings.length > 0 ? `${result.summary}\n${result.warnings.join("\n")}` : result.summary;
  vscode.window.showInformationMessage(message);
}
