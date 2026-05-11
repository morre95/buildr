export type BuildrEnvironmentKind = "local" | "wsl" | "remote-ssh" | "dev-container" | "codespaces" | "web" | "unknown-remote";

export interface RemoteCompatibilityInput {
  remoteName?: string;
  uiKind?: "desktop" | "web";
  isTrusted?: boolean;
  modelBaseUrl?: string;
  env?: Record<string, string | undefined>;
}

export interface RemoteCompatibilityCheck {
  id: string;
  ok: boolean;
  severity: "info" | "warning" | "error";
  message: string;
}

export interface RemoteCompatibilityReport {
  environment: BuildrEnvironmentKind;
  summary: string;
  checks: RemoteCompatibilityCheck[];
}

export function assessRemoteCompatibility(input: RemoteCompatibilityInput = {}): RemoteCompatibilityReport {
  const environment = detectBuildrEnvironment(input);
  const checks: RemoteCompatibilityCheck[] = [];

  checks.push({
    id: "workspace-trust",
    ok: input.isTrusted !== false,
    severity: input.isTrusted === false ? "error" : "info",
    message: input.isTrusted === false
      ? "Workspace is untrusted; Buildr must stay in read-only Plan Mode."
      : "Workspace trust allows approved execution."
  });

  if (environment === "web") {
    checks.push({
      id: "web-extension-host",
      ok: false,
      severity: "warning",
      message: "VS Code Web cannot run Node-only indexing, terminal, or local model features."
    });
  }

  if (input.modelBaseUrl !== undefined && isLocalhostUrl(input.modelBaseUrl) && environment !== "local" && environment !== "wsl") {
    checks.push({
      id: "localhost-model-endpoint",
      ok: false,
      severity: "warning",
      message: `Model endpoint ${input.modelBaseUrl} resolves from the ${environment} extension host, not necessarily this desktop.`
    });
  }

  if (environment === "codespaces") {
    checks.push({
      id: "codespaces-local-models",
      ok: false,
      severity: "warning",
      message: "Codespaces usually cannot reach desktop-local Ollama or LM Studio without an explicit secure tunnel."
    });
  }

  if (checks.length === 0 || checks.every((check) => check.ok)) {
    checks.push({
      id: "remote-compatible",
      ok: true,
      severity: "info",
      message: "No remote compatibility blockers detected."
    });
  }

  const blockingCount = checks.filter((check) => !check.ok).length;
  return {
    environment,
    summary: `${environment} environment with ${blockingCount} compatibility warning(s).`,
    checks
  };
}

export function detectBuildrEnvironment(input: RemoteCompatibilityInput = {}): BuildrEnvironmentKind {
  if (input.uiKind === "web") {
    return "web";
  }
  if (input.env?.CODESPACES === "true") {
    return "codespaces";
  }
  if (input.remoteName === "wsl" || input.env?.WSL_DISTRO_NAME !== undefined) {
    return "wsl";
  }
  if (input.remoteName === "ssh-remote") {
    return "remote-ssh";
  }
  if (input.remoteName === "dev-container" || input.env?.REMOTE_CONTAINERS === "true") {
    return "dev-container";
  }
  if (input.remoteName !== undefined && input.remoteName.length > 0) {
    return "unknown-remote";
  }
  return "local";
}

function isLocalhostUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  } catch {
    return false;
  }
}
