import type {
  ChatOptions,
  ChatRequest,
  ModelAdapter,
  ModelCapabilities,
  ModelDelta,
  ModelInfo,
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
  error?: unknown;
  delta?: {
    type?: string;
    text?: string;
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
      nativeTools: false,
      parallelTools: false,
      streamingToolCalls: false,
      structuredOutput: true,
      jsonSchemaOutput: false,
      thinking: false,
      images: false,
      embeddings: false,
      recommendedContextTokens: 200000
    };
  }

  async *chat(request: ChatRequest, options: ChatOptions = {}): AsyncIterable<ModelDelta> {
    const init: RequestInit = {
      method: "POST",
      headers: await this.createHeaders(),
      body: JSON.stringify({
        model: request.model,
        max_tokens: 4096,
        stream: true,
        temperature: request.temperature ?? 0.1,
        system: createAnthropicSystemPrompt(request.messages),
        messages: request.messages.filter((message) => message.role !== "system").map(toAnthropicMessage)
      })
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

function toAnthropicMessage(message: ChatRequest["messages"][number]): Record<string, unknown> {
  if (message.role === "assistant") {
    return { role: "assistant", content: message.content };
  }
  if (message.role === "tool") {
    return { role: "user", content: `Tool result${message.name === undefined ? "" : ` from ${message.name}`}:\n${message.content}` };
  }
  return { role: "user", content: message.content };
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
