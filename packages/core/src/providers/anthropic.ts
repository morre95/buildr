import type {
  ChatOptions,
  ChatRequest,
  ModelAdapter,
  ModelCapabilities,
  ModelDelta,
  ModelInfo,
  ToolCall,
  ToolDefinition,
  TokenCountInput,
  TokenCountResult
} from "../types.js";
import { createProviderError } from "./errors.js";

interface AnthropicModelList {
  data?: Array<{
    id: string;
    display_name?: string;
  }>;
}

interface AnthropicStreamEvent {
  type?: string;
  index?: number;
  error?: unknown;
  content_block?: {
    type?: string;
    id?: string;
    name?: string;
  };
  delta?: {
    type?: string;
    text?: string;
    partial_json?: string;
  };
}

export interface AnthropicAdapterOptions {
  baseUrl?: string;
  apiKey?: string;
  getApiKey?: () => Promise<string | undefined>;
}

export class AnthropicAdapter implements ModelAdapter {
  readonly id = "anthropic";
  readonly displayName = "Anthropic";
  readonly provider = "anthropic";

  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly getApiKey: (() => Promise<string | undefined>) | undefined;

  constructor(options: AnthropicAdapterOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.getApiKey = options.getApiKey;
  }

  async getCapabilities(): Promise<ModelCapabilities> {
    return {
      nativeTools: true,
      parallelTools: true,
      streamingToolCalls: true,
      structuredOutput: true,
      jsonSchemaOutput: false,
      thinking: false,
      images: false,
      embeddings: false,
      recommendedContextTokens: 200000
    };
  }

  async *chat(request: ChatRequest, options: ChatOptions = {}): AsyncIterable<ModelDelta> {
    const body: Record<string, unknown> = {
      model: request.model,
      max_tokens: 4096,
      stream: true,
      temperature: request.temperature ?? 0.1,
      system: createAnthropicSystemPrompt(request.messages),
      messages: request.messages.filter((message) => message.role !== "system").map(toAnthropicMessage)
    };
    if (request.tools !== undefined && request.tools.length > 0) {
      body.tools = request.tools.map(toAnthropicToolDefinition);
    }
    const init: RequestInit = {
      method: "POST",
      headers: await this.createHeaders(),
      body: JSON.stringify(body)
    };
    if (options.signal !== undefined) {
      init.signal = options.signal;
    }

    const response = await fetch(`${this.baseUrl}/v1/messages`, init);
    if (!response.ok) {
      const message = extractProviderErrorMessage(await readErrorResponse(response));
      throw createProviderError(message ?? `Anthropic chat failed with HTTP ${response.status}.`);
    }
    if (response.body === null) {
      throw new Error(`Anthropic chat failed with HTTP ${response.status}.`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let eventType: string | undefined;
    const activeToolCalls = new Map<number, { id: string; name: string; arguments: string }>();

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
        const parsed = JSON.parse(data) as AnthropicStreamEvent;
        const errorMessage = extractProviderErrorMessage(parsed.error);
        if (eventType === "error" || parsed.type === "error" || errorMessage !== undefined) {
          throw createProviderError(errorMessage ?? data);
        }
        if (parsed.type === "content_block_delta" && parsed.delta?.type === "text_delta" && parsed.delta.text !== undefined) {
          yield { type: "text", content: parsed.delta.text };
        }
        if (parsed.type === "content_block_start" && parsed.content_block?.type === "tool_use") {
          const index = parsed.index ?? activeToolCalls.size;
          activeToolCalls.set(index, {
            id: parsed.content_block.id ?? `tool:${Date.now()}:${Math.random().toString(36).slice(2)}`,
            name: parsed.content_block.name ?? "",
            arguments: ""
          });
        }
        if (parsed.type === "content_block_delta" && parsed.delta?.type === "input_json_delta" && parsed.delta.partial_json !== undefined) {
          const index = parsed.index ?? (activeToolCalls.size - 1);
          const existing = activeToolCalls.get(index);
          if (existing !== undefined) {
            existing.arguments += parsed.delta.partial_json;
          }
        }
        if (parsed.type === "content_block_stop" && parsed.index !== undefined) {
          const toolCall = activeToolCalls.get(parsed.index);
          if (toolCall !== undefined && toolCall.name.length > 0) {
            yield { type: "tool_call", toolCall: parseAnthropicToolCall(toolCall) };
            activeToolCalls.delete(parsed.index);
          }
        }
        if (parsed.type === "message_stop") {
          yield { type: "done" };
        }
      }
    }
  }

  async countTokens(input: TokenCountInput): Promise<TokenCountResult> {
    const chars = input.messages.reduce((total, message) => total + message.content.length, 0);
    return { tokens: Math.ceil(chars / 4), approximate: true };
  }

  async listModels(): Promise<ModelInfo[]> {
    const response = await fetch(`${this.baseUrl}/v1/models`, {
      headers: await this.createHeaders()
    });
    if (!response.ok) {
      throw new Error(`Anthropic model listing failed with HTTP ${response.status}.`);
    }
    const data = (await response.json()) as AnthropicModelList;
    return (data.data ?? []).map((model) => ({
      id: model.id,
      displayName: model.display_name ?? model.id,
      provider: this.provider
    }));
  }

  private async createHeaders(): Promise<Record<string, string>> {
    const apiKey = this.apiKey ?? await this.getApiKey?.();
    return {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      ...(apiKey === undefined || apiKey.length === 0 ? {} : { "x-api-key": apiKey })
    };
  }
}

function createAnthropicSystemPrompt(messages: ChatRequest["messages"]): string | undefined {
  const content = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
  return content.length === 0 ? undefined : content;
}

function toAnthropicToolDefinition(tool: ToolDefinition): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema
  };
}

function toAnthropicMessage(message: ChatRequest["messages"][number]): Record<string, unknown> {
  if (message.role === "assistant" && message.toolCalls !== undefined && message.toolCalls.length > 0) {
    const content: Array<Record<string, unknown>> = [];
    if (message.content.length > 0) {
      content.push({ type: "text", text: message.content });
    }
    for (const toolCall of message.toolCalls) {
      content.push({
        type: "tool_use",
        id: toolCall.id,
        name: toolCall.name,
        input: toolCall.arguments
      });
    }
    return { role: "assistant", content };
  }
  if (message.role === "assistant") {
    return { role: "assistant", content: message.content };
  }
  if (message.role === "tool") {
    return {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: message.toolCallId,
        content: message.content
      }]
    };
  }
  return { role: "user", content: message.content };
}

function parseAnthropicToolCall(toolCall: { id: string; name: string; arguments: string }): ToolCall {
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
    id: toolCall.id,
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
