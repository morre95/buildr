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

interface LMStudioNativeModelList {
  models?: Array<{
    type?: string;
    key: string;
    display_name?: string;
    publisher?: string;
    architecture?: string;
    quantization?: { name?: string };
    params_string?: string;
  }>;
}

interface LMStudioNativeStreamEvent {
  type?: string;
  delta?: {
    content?: string;
  };
  response?: {
    model_instance_id?: string;
    message?: {
      role?: string;
      content?: string;
    };
  };
  error?: unknown;
}

export interface LMStudioNativeAdapterOptions {
  baseUrl?: string;
}

export class LMStudioNativeAdapter implements ModelAdapter {
  readonly id = "lmstudio-native";
  readonly displayName = "LM Studio Native";
  readonly provider = "lmstudio-native";

  private readonly baseUrl: string;

  constructor(options: LMStudioNativeAdapterOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "http://127.0.0.1:1234").replace(/\/$/, "");
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
      recommendedContextTokens: 32000
    };
  }

  async getContextWindow(modelId: string, options: ChatOptions = {}): Promise<number | undefined> {
    const init: RequestInit = {};
    if (options.signal !== undefined) {
      init.signal = options.signal;
    }
    const response = await fetch(`${this.baseUrl}/api/v0/models`, init);
    if (!response.ok) {
      return undefined;
    }
    const data = (await response.json()) as {
      data?: Array<{ id?: string; state?: string; max_context_length?: number; loaded_context_length?: number }>;
    };
    const model = (data.data ?? []).find((entry) => entry.id === modelId);
    if (model === undefined) {
      return undefined;
    }
    if (model.state === "loaded" && typeof model.loaded_context_length === "number") {
      return model.loaded_context_length;
    }
    return typeof model.max_context_length === "number" ? model.max_context_length : undefined;
  }

  async *chat(request: ChatRequest, options: ChatOptions = {}): AsyncIterable<ModelDelta> {
    const systemPrompt = request.messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n");

    const input = request.messages
      .filter((message) => message.role !== "system")
      .map((message) => `${message.role}: ${message.content}`)
      .join("\n\n");

    const body: Record<string, unknown> = {
      model: request.model,
      input,
      stream: true,
      store: false,
      options: {
        temperature: request.temperature ?? 0.1
      }
    };
    if (systemPrompt.length > 0) {
      body.system_prompt = systemPrompt;
    }

    const init: RequestInit = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    };
    if (options.signal !== undefined) {
      init.signal = options.signal;
    }

    const response = await fetch(`${this.baseUrl}/api/v1/chat`, init);
    if (!response.ok) {
      const message = extractProviderErrorMessage(await readErrorResponse(response));
      throw createProviderError(message ?? `LM Studio native chat failed with HTTP ${response.status}.`);
    }
    if (response.body === null) {
      throw new Error(`LM Studio native chat failed with HTTP ${response.status}.`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

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
          continue;
        }
        if (!trimmed.startsWith("data:")) {
          continue;
        }

        const data = trimmed.slice("data:".length).trim();
        if (data.length === 0) {
          continue;
        }
        const parsed = JSON.parse(data) as LMStudioNativeStreamEvent;
        const errorMessage = extractProviderErrorMessage(parsed.error);
        if (parsed.type === "error" || errorMessage !== undefined) {
          throw createProviderError(errorMessage ?? data);
        }
        if (parsed.type === "message.delta" && parsed.delta?.content !== undefined) {
          yield { type: "text", content: parsed.delta.content };
        }
        if (parsed.type === "reasoning.delta" && parsed.delta?.content !== undefined) {
          yield { type: "text", content: parsed.delta.content };
        }
        if (parsed.type === "chat.end") {
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
    const response = await fetch(`${this.baseUrl}/api/v1/models`);
    if (!response.ok) {
      throw new Error(`LM Studio native model listing failed with HTTP ${response.status}.`);
    }
    const data = (await response.json()) as LMStudioNativeModelList;
    return (data.models ?? []).map((model) => ({
      id: model.key,
      displayName: model.display_name ?? model.key,
      provider: this.provider
    }));
  }

  async loadModel(modelId: string, options: ChatOptions = {}): Promise<void> {
    const init: RequestInit = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: modelId })
    };
    if (options.signal !== undefined) {
      init.signal = options.signal;
    }
    const response = await fetch(`${this.baseUrl}/api/v1/models/load`, init);
    if (!response.ok) {
      const message = extractProviderErrorMessage(await readErrorResponse(response));
      throw createProviderError(message ?? `LM Studio failed to load model ${modelId} with HTTP ${response.status}.`);
    }
  }
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
