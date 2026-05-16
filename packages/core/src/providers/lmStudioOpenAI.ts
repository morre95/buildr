import type {
  ChatOptions,
  ChatRequest,
  ModelAdapter,
  ModelCapabilities,
  ModelDelta,
  ModelInfo,
  ProviderId,
  ToolCall,
  ToolDefinition,
  TokenCountInput,
  TokenCountResult
} from "../types.js";
import { createProviderError } from "./errors.js";

interface OpenAICompatibleModelList {
  data?: Array<{
    id: string;
  }>;
}

interface OpenAICompatibleChatChunk {
  error?: unknown;
  choices?: Array<{
    delta?: {
      content?: string;
      tool_calls?: OpenAICompatibleToolCallChunk[];
    };
    finish_reason?: string | null;
  }>;
}

interface OpenAICompatibleToolCallChunk {
  index?: number;
  id?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

export interface OpenAICompatibleAdapterOptions {
  baseUrl?: string;
  apiKey?: string;
  getApiKey?: () => Promise<string | undefined>;
  defaultHeaders?: Record<string, string>;
  provider?: Extract<ProviderId, "lmstudio-openai" | "openai-compatible" | "openai" | "openrouter">;
  displayName?: string;
  chatPath?: string;
  modelsPath?: string;
  embeddings?: boolean;
}

export interface LMStudioOpenAIAdapterOptions {
  baseUrl?: string;
}

export class OpenAICompatibleAdapter implements ModelAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly provider: Extract<ProviderId, "lmstudio-openai" | "openai-compatible" | "openai" | "openrouter">;

  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly getApiKey: (() => Promise<string | undefined>) | undefined;
  private readonly defaultHeaders: Record<string, string>;
  private readonly chatPath: string;
  private readonly modelsPath: string;
  private readonly embeddings: boolean;

  constructor(options: OpenAICompatibleAdapterOptions = {}) {
    this.provider = options.provider ?? "openai-compatible";
    this.id = this.provider;
    this.displayName = options.displayName ?? "OpenAI-Compatible";
    this.baseUrl = (options.baseUrl ?? "http://127.0.0.1:1234").replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.getApiKey = options.getApiKey;
    this.defaultHeaders = options.defaultHeaders ?? {};
    this.chatPath = options.chatPath ?? "/v1/chat/completions";
    this.modelsPath = options.modelsPath ?? "/v1/models";
    this.embeddings = options.embeddings ?? false;
  }

  async getCapabilities(): Promise<ModelCapabilities> {
    return {
      nativeTools: true,
      parallelTools: false,
      streamingToolCalls: false,
      structuredOutput: true,
      jsonSchemaOutput: false,
      thinking: false,
      images: false,
      embeddings: this.embeddings,
      recommendedContextTokens: 32000
    };
  }

  async *chat(request: ChatRequest, options: ChatOptions = {}): AsyncIterable<ModelDelta> {
    const headers = await this.createHeaders();
    const init: RequestInit = {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: request.model,
        messages: request.messages.map(toOpenAIMessage),
        stream: true,
        temperature: request.temperature ?? 0.1,
        tools: request.tools?.map(toOpenAIToolDefinition)
      })
    };
    if (options.signal !== undefined) {
      init.signal = options.signal;
    }

    const response = await fetch(`${this.baseUrl}${this.chatPath}`, init);
    if (!response.ok) {
      const message = extractProviderErrorMessage(await readErrorResponse(response));
      throw createProviderError(message ?? `${this.displayName} chat failed with HTTP ${response.status}.`);
    }
    if (response.body === null) {
      throw new Error(`${this.displayName} chat failed with HTTP ${response.status}.`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let eventType: string | undefined;
    const toolCalls = new Map<number, { id?: string; name?: string; arguments: string }>();

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length === 0) {
          eventType = undefined;
          continue;
        }
        if (trimmed.startsWith("event:")) {
          eventType = trimmed.slice("event:".length).trim();
          continue;
        }
        if (!trimmed.startsWith("data:")) {
          continue;
        }
        const data = trimmed.slice("data:".length).trim();
        if (data === "[DONE]") {
          yield { type: "done" };
          continue;
        }
        const parsed = JSON.parse(data) as OpenAICompatibleChatChunk;
        const errorMessage = extractProviderErrorMessage(parsed.error);
        if (errorMessage !== undefined) {
          throw createProviderError(errorMessage);
        }
        if (eventType === "error") {
          throw createProviderError(extractProviderErrorMessage(parsed) ?? data);
        }
        const content = parsed.choices?.[0]?.delta?.content;
        if (content !== undefined) {
          yield { type: "text", content };
        }
        const deltas = parsed.choices?.[0]?.delta?.tool_calls ?? [];
        for (const toolCall of deltas) {
          const index = toolCall.index ?? toolCalls.size;
          const existing = toolCalls.get(index) ?? { arguments: "" };
          const id = toolCall.id ?? existing.id;
          const name = toolCall.function?.name ?? existing.name;
          const next = {
            arguments: existing.arguments + (toolCall.function?.arguments ?? ""),
            ...(id === undefined ? {} : { id }),
            ...(name === undefined ? {} : { name })
          };
          toolCalls.set(index, next);
        }
        if (parsed.choices?.[0]?.finish_reason === "tool_calls") {
          for (const toolCall of toolCalls.values()) {
            const normalized = parseToolCall(toolCall);
            if (normalized !== undefined) {
              yield { type: "tool_call", toolCall: normalized };
            }
          }
          toolCalls.clear();
        }
      }
    }
  }

  async countTokens(input: TokenCountInput): Promise<TokenCountResult> {
    const chars = input.messages.reduce((total, message) => total + message.content.length, 0);
    return { tokens: Math.ceil(chars / 4), approximate: true };
  }

  async listModels(): Promise<ModelInfo[]> {
    const response = await fetch(`${this.baseUrl}${this.modelsPath}`, {
      headers: await this.createHeaders()
    });
    if (!response.ok) {
      throw new Error(`${this.displayName} model listing failed with HTTP ${response.status}.`);
    }
    const data = (await response.json()) as OpenAICompatibleModelList;
    return (data.data ?? []).map((model) => ({
      id: model.id,
      displayName: model.id,
      provider: this.provider
    }));
  }

  private async createHeaders(): Promise<Record<string, string>> {
    const apiKey = this.apiKey ?? await this.getApiKey?.();
    return {
      "content-type": "application/json",
      ...this.defaultHeaders,
      ...(apiKey === undefined || apiKey.length === 0 ? {} : { authorization: `Bearer ${apiKey}` })
    };
  }
}

export class LMStudioOpenAIAdapter extends OpenAICompatibleAdapter {
  constructor(options: LMStudioOpenAIAdapterOptions = {}) {
    super({
      ...options,
      provider: "lmstudio-openai",
      displayName: "LM Studio OpenAI-Compatible",
      embeddings: true
    });
  }
}

export class OpenAIAdapter extends OpenAICompatibleAdapter {
  constructor(options: Omit<OpenAICompatibleAdapterOptions, "provider" | "displayName" | "baseUrl"> & { baseUrl?: string } = {}) {
    super({
      ...options,
      baseUrl: options.baseUrl ?? "https://api.openai.com",
      provider: "openai",
      displayName: "OpenAI"
    });
  }
}

export class OpenRouterAdapter extends OpenAICompatibleAdapter {
  constructor(options: Omit<OpenAICompatibleAdapterOptions, "provider" | "displayName" | "baseUrl" | "chatPath" | "modelsPath"> & { baseUrl?: string } = {}) {
    super({
      ...options,
      baseUrl: options.baseUrl ?? "https://openrouter.ai/api",
      provider: "openrouter",
      displayName: "OpenRouter",
      chatPath: "/v1/chat/completions",
      modelsPath: "/v1/models",
      defaultHeaders: {
        "HTTP-Referer": "https://github.com/buildr",
        "X-OpenRouter-Title": "Buildr",
        ...(options.defaultHeaders ?? {})
      }
    });
  }
}

function toOpenAIToolDefinition(tool: ToolDefinition): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema
    }
  };
}

function toOpenAIMessage(message: ChatRequest["messages"][number]): Record<string, unknown> {
  if (message.role === "assistant" && message.toolCalls !== undefined) {
    return {
      role: "assistant",
      content: message.content,
      tool_calls: message.toolCalls.map((toolCall) => ({
        id: toolCall.id,
        type: "function",
        function: {
          name: toolCall.name,
          arguments: JSON.stringify(toolCall.arguments)
        }
      }))
    };
  }
  if (message.role === "tool") {
    return {
      role: "tool",
      content: message.content,
      tool_call_id: message.toolCallId,
      name: message.name
    };
  }
  return {
    role: message.role,
    content: message.content
  };
}

function parseToolCall(toolCall: { id?: string; name?: string; arguments: string }): ToolCall | undefined {
  if (toolCall.name === undefined || toolCall.name.trim().length === 0) {
    return undefined;
  }
  let args: Record<string, unknown> = {};
  if (toolCall.arguments.trim().length > 0) {
    try {
      const parsed = JSON.parse(toolCall.arguments) as unknown;
      args = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      args = {};
    }
  }
  return {
    id: toolCall.id ?? `tool:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    name: toolCall.name,
    arguments: args
  };
}

async function readErrorResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.trim().length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function extractProviderErrorMessage(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of ["message", "detail", "error"]) {
    const nested = extractProviderErrorMessage(record[key]);
    if (nested !== undefined) {
      return nested;
    }
  }
  return undefined;
}
