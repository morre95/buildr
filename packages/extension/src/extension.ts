import { BuildrCore } from "@buildr/core";
import * as vscode from "vscode";
import { StepPanel } from "./webview/stepPanel.js";

let activeAbortController: AbortController | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const core = new BuildrCore();
  const stepPanel = new StepPanel(context.extensionUri);

  context.subscriptions.push(
    vscode.commands.registerCommand("buildr.plan", async () => {
      const goal = await vscode.window.showInputBox({
        title: "Buildr: Plan",
        prompt: "Describe the coding task to plan.",
        ignoreFocusOut: true
      });

      if (!goal) {
        return;
      }

      activeAbortController = new AbortController();
      const plan = core.createPlan(goal);
      stepPanel.showPlan(plan);
      vscode.window.showInformationMessage(`Buildr created a ${plan.steps.length}-step plan.`);
    }),
    vscode.commands.registerCommand("buildr.runApprovedPlan", () => {
      if (!vscode.workspace.isTrusted) {
        vscode.window.showWarningMessage("Buildr execution is disabled until this workspace is trusted.");
        return;
      }

      vscode.window.showInformationMessage("Buildr Phase 1A can plan tasks; approved execution wiring is next.");
    }),
    vscode.commands.registerCommand("buildr.configureModel", async () => {
      const config = vscode.workspace.getConfiguration("buildr.model");
      const currentUrl = config.get<string>("ollamaBaseUrl", "http://127.0.0.1:11434");
      const nextUrl = await vscode.window.showInputBox({
        title: "Buildr: Configure Ollama Endpoint",
        value: currentUrl,
        ignoreFocusOut: true
      });

      if (nextUrl) {
        await config.update("ollamaBaseUrl", nextUrl, vscode.ConfigurationTarget.Workspace);
      }
    }),
    vscode.commands.registerCommand("buildr.stop", () => {
      activeAbortController?.abort();
      activeAbortController = undefined;
      vscode.window.showInformationMessage("Buildr stopped the active operation.");
    })
  );
}

export function deactivate(): void {
  activeAbortController?.abort();
}
