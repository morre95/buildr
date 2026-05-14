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

export interface LMStudioOpenAIAdapterOptions {
  baseUrl?: string;
}

export class LMStudioOpenAIAdapter implements ModelAdapter {
  readonly id = "lmstudio-openai";
  readonly displayName = "LM Studio OpenAI-Compatible";
  readonly provider = "lmstudio-openai";

  private readonly baseUrl: string;

  constructor(options: LMStudioOpenAIAdapterOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "http://127.0.0.1:1234").replace(/\/$/, "");
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
      embeddings: true,
      recommendedContextTokens: 32000
    };
  }

  async *chat(request: ChatRequest, options: ChatOptions = {}): AsyncIterable<ModelDelta> {
    const init: RequestInit = {
      method: "POST",
      headers: { "content-type": "application/json" },
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

    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, init);
    if (!response.ok) {
      const message = extractProviderErrorMessage(await readErrorResponse(response));
      throw createProviderError(message ?? `LM Studio chat failed with HTTP ${response.status}.`);
    }
    if (response.body === null) {
      throw new Error(`LM Studio chat failed with HTTP ${response.status}.`);
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
    const response = await fetch(`${this.baseUrl}/v1/models`);
    if (!response.ok) {
      throw new Error(`LM Studio model listing failed with HTTP ${response.status}.`);
    }
    const data = (await response.json()) as OpenAICompatibleModelList;
    return (data.data ?? []).map((model) => ({
      id: model.id,
      displayName: model.id,
      provider: this.provider
    }));
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
