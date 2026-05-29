export type ProviderId =
  | "ollama"
  | "lmstudio-openai"
  | "lmstudio-native"
  | "openai-compatible"
  | "openrouter"
  | "anthropic"
  | "openai";

export interface ModelCapabilities {
  nativeTools: boolean;
  parallelTools: boolean;
  streamingToolCalls: boolean;
  structuredOutput: boolean;
  jsonSchemaOutput: boolean;
  thinking: boolean;
  images: boolean;
  embeddings: boolean;
  maxContextTokens?: number;
  recommendedContextTokens?: number;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
}

export interface ChatOptions {
  signal?: AbortSignal;
}

export interface ModelDelta {
  type: "text" | "tool_call" | "done";
  content?: string;
  toolCall?: ToolCall;
}

export interface TokenCountInput {
  messages: ChatMessage[];
}

export interface TokenCountResult {
  tokens: number;
  approximate: boolean;
}

export interface ModelInfo {
  id: string;
  displayName: string;
  provider: ProviderId;
}

export interface ModelAdapter {
  id: string;
  displayName: string;
  provider: ProviderId;
  getCapabilities(modelId: string): Promise<ModelCapabilities>;
  chat(request: ChatRequest, options?: ChatOptions): AsyncIterable<ModelDelta>;
  countTokens(input: TokenCountInput): Promise<TokenCountResult>;
  listModels?(): Promise<ModelInfo[]>;
  loadModel?(modelId: string, options?: ChatOptions): Promise<void>;
  getContextWindow?(modelId: string, options?: ChatOptions): Promise<number | undefined>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  permission: PermissionLevel;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult<TData = unknown> {
  ok: boolean;
  summary: string;
  data?: TData;
  warnings: string[];
  provenance: Provenance[];
}

export interface Provenance {
  kind: "file" | "command" | "diagnostic" | "model" | "user" | "generated";
  source: string;
  range?: {
    startLine: number;
    endLine: number;
  };
}

export type PermissionLevel =
  | "auto_allow"
  | "context_review"
  | "require_approval"
  | "always_confirm"
  | "always_deny";

export type PermissionDecision = "allow" | "ask" | "deny";

export interface VerificationEvidence {
  command?: string;
  exitCode?: number;
  outputExcerpt?: string;
  diagnosticsSummary?: string;
  skippedReason?: string;
}
