import { buildWorkspaceIndex, rankWorkspaceContext } from "@buildr/core";
import * as vscode from "vscode";

interface RegisterableLanguageModelApi {
  registerTool?: (name: string, tool: unknown) => vscode.Disposable;
}

interface ToolInvocation {
  input?: unknown;
}

export function registerBuildrLanguageModelTools(context: vscode.ExtensionContext): void {
  const lm = vscode.lm as RegisterableLanguageModelApi | undefined;
  if (lm?.registerTool === undefined) {
    return;
  }

  context.subscriptions.push(lm.registerTool("buildr_workspaceContext", new WorkspaceContextTool()));
}

class WorkspaceContextTool {
  async invoke(invocation: ToolInvocation): Promise<vscode.LanguageModelToolResult> {
    const query = parseQuery(invocation.input);
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (root === undefined) {
      return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart("No workspace folder is open.")]);
    }

    const index = await buildWorkspaceIndex(root);
    const ranked = rankWorkspaceContext(index, query, 5);
    const text = ranked.map((item) => `${item.file.relativePath}: ${item.file.summary}`).join("\n");
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text || "No relevant workspace context found.")]);
  }
}

function parseQuery(input: unknown): string {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return "";
  }
  const query = (input as Record<string, unknown>).query;
  return typeof query === "string" ? query : "";
}
