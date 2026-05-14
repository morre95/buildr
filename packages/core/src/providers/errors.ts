export const LM_STUDIO_CONTEXT_SLOT_DIAGNOSTIC =
  "Provider context may be lower than the configured model context. In LM Studio, check the server logs for an effective request slot such as n_ctx_slot = 4096 even when the model context setting is higher.";

export class ProviderError extends Error {
  constructor(message: string, readonly kind: "context" | "unknown" = "unknown") {
    super(message);
    this.name = "ProviderError";
  }
}

export function createProviderError(message: string): ProviderError {
  return new ProviderError(message, isProviderContextErrorMessage(message) ? "context" : "unknown");
}

export function isProviderContextError(error: unknown): boolean {
  if (error instanceof ProviderError && error.kind === "context") {
    return true;
  }
  return isProviderContextErrorMessage(error instanceof Error ? error.message : String(error));
}

export function providerContextWarnings(error: unknown): string[] {
  if (!isProviderContextError(error)) {
    return [];
  }
  const message = error instanceof Error ? error.message : String(error);
  return [
    message,
    LM_STUDIO_CONTEXT_SLOT_DIAGNOSTIC
  ];
}

export function providerErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isProviderContextErrorMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("context size has been exceeded") ||
    normalized.includes("context length") ||
    normalized.includes("context window") ||
    normalized.includes("maximum context") ||
    normalized.includes("max context") ||
    normalized.includes("prompt is too long") ||
    normalized.includes("too many tokens") ||
    normalized.includes("kv cache") ||
    normalized.includes("kv-cache") ||
    normalized.includes("n_ctx") ||
    normalized.includes("n_ctx_slot")
  );
}
