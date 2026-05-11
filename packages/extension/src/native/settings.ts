import * as vscode from "vscode";

const RULE_PACK_OPTIONS = ["agent-behavior", "verification", "git-workflow", "security", "performance"];

export async function openBuildrSettings(): Promise<void> {
  const choice = await vscode.window.showQuickPick([
    "Model provider",
    "Model id",
    "Ollama base URL",
    "LM Studio base URL",
    "Token budget",
    "Default write policy",
    "Cloud-send policy",
    "Rule packs",
    "Verification level",
    "Embeddings provider",
    "Open Settings UI"
  ], {
    title: "Buildr Settings",
    placeHolder: "Choose a Buildr setting to update."
  });

  if (choice === undefined) {
    return;
  }

  if (choice === "Open Settings UI") {
    await vscode.commands.executeCommand("workbench.action.openSettings", "@ext:buildr.buildr-vscode");
    return;
  }

  const target = vscode.ConfigurationTarget.Workspace;
  switch (choice) {
    case "Model provider":
      await updateChoice("buildr.model", "provider", ["ollama", "lmstudio-openai", "lmstudio-native", "openai-compatible"], target);
      break;
    case "Model id":
      await updateInput("buildr.model", "modelId", "Model id to send to the configured provider, such as qwen2.5-coder or the loaded LM Studio model id.", target);
      break;
    case "Ollama base URL":
      await updateInput("buildr.model", "ollamaBaseUrl", "Ollama endpoint reachable from this extension host.", target);
      break;
    case "LM Studio base URL":
      await updateInput("buildr.model", "lmStudioBaseUrl", "LM Studio base URL reachable from this extension host. Do not include /v1; Buildr adds it.", target);
      break;
    case "Token budget":
      await updateNumber("buildr.context", "tokenBudget", "Maximum context token budget.", target);
      break;
    case "Default write policy":
      await updateChoice("buildr.permissions", "defaultWritePolicy", ["context_review", "require_approval", "always_confirm", "always_deny"], target);
      break;
    case "Cloud-send policy":
      await updateChoice("buildr.privacy", "cloudSendPolicy", ["never", "ask", "allow"], target);
      break;
    case "Rule packs":
      await updateRulePacks(target);
      break;
    case "Verification level":
      await updateChoice("buildr.verification", "level", ["light", "standard", "strict"], target);
      break;
    case "Embeddings provider":
      await updateChoice("buildr.embeddings", "provider", ["local-transformers", "ollama", "lmstudio-openai", "disabled"], target);
      break;
  }
}

async function updateChoice(section: string, key: string, values: string[], target: vscode.ConfigurationTarget): Promise<void> {
  const config = vscode.workspace.getConfiguration(section);
  const current = config.get<string>(key);
  const selected = await vscode.window.showQuickPick(values, {
    title: `Buildr: ${key}`,
    placeHolder: current === undefined ? "Choose a value." : `Current: ${current}`
  });
  if (selected !== undefined) {
    await config.update(key, selected, target);
  }
}

async function updateInput(section: string, key: string, prompt: string, target: vscode.ConfigurationTarget): Promise<void> {
  const config = vscode.workspace.getConfiguration(section);
  const currentValue = config.get<string>(key);
  const value = await vscode.window.showInputBox({
    title: `Buildr: ${key}`,
    prompt,
    ignoreFocusOut: true,
    ...(currentValue === undefined ? {} : { value: currentValue })
  });
  if (value !== undefined && value.trim().length > 0) {
    await config.update(key, value.trim(), target);
  }
}

async function updateNumber(section: string, key: string, prompt: string, target: vscode.ConfigurationTarget): Promise<void> {
  const config = vscode.workspace.getConfiguration(section);
  const value = await vscode.window.showInputBox({
    title: `Buildr: ${key}`,
    value: String(config.get<number>(key) ?? ""),
    prompt,
    ignoreFocusOut: true,
    validateInput: (input) => Number.isFinite(Number(input)) && Number(input) > 0 ? undefined : "Enter a positive number."
  });
  if (value !== undefined) {
    await config.update(key, Number(value), target);
  }
}

async function updateRulePacks(target: vscode.ConfigurationTarget): Promise<void> {
  const config = vscode.workspace.getConfiguration("buildr.rules");
  const current = new Set(config.get<string[]>("rulePacks", []));
  const selected = await vscode.window.showQuickPick(RULE_PACK_OPTIONS.map((label) => ({
    label,
    picked: current.has(label)
  })), {
    title: "Buildr: Rule packs",
    canPickMany: true
  });
  if (selected !== undefined) {
    await config.update("rulePacks", selected.map((item) => item.label), target);
  }
}
