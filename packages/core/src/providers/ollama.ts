import type {
  ChatRequest,
  ChatOptions,
  ModelAdapter,
  ModelCapabilities,
  ModelDelta,
  ModelInfo,
  TokenCountInput,
  TokenCountResult
} from "../types.js";

interface OllamaTagsResponse {
  models?: Array<{
    name: string;
  }>;
}

interface OllamaChatLine {
  message?: {
    content?: string;
  };
  done?: boolean;
}

export interface OllamaAdapterOptions {
  baseUrl?: string;
}

export class OllamaAdapter implements ModelAdapter {
  readonly id = "ollama";
  readonly displayName = "Ollama";
  readonly provider = "ollama";

  private readonly baseUrl: string;

  constructor(options: OllamaAdapterOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "http://127.0.0.1:11434").replace(/\/$/, "");
  }

  async getCapabilities(modelId: string): Promise<ModelCapabilities> {
    return {
      nativeTools: modelId.includes("tool") || modelId.includes("qwen") || modelId.includes("llama"),
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

  async *chat(request: ChatRequest, options: ChatOptions = {}): AsyncIterable<ModelDelta> {
    const init: RequestInit = {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        stream: true,
        options: {
          temperature: request.temperature ?? 0.1
        },
        tools: request.tools
      })
    };
    if (options.signal !== undefined) {
      init.signal = options.signal;
    }

    const response = await fetch(`${this.baseUrl}/api/chat`, init);

    if (!response.ok || response.body === null) {
      throw new Error(`Ollama chat failed with HTTP ${response.status}.`);
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
        const parsed = JSON.parse(trimmed) as OllamaChatLine;
        if (parsed.message?.content) {
          yield { type: "text", content: parsed.message.content };
        }
        if (parsed.done) {
          yield { type: "done" };
        }
      }
    }
  }

  async countTokens(input: TokenCountInput): Promise<TokenCountResult> {
    const chars = input.messages.reduce((total, message) => total + message.content.length, 0);
    return {
      tokens: Math.ceil(chars / 4),
      approximate: true
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    const response = await fetch(`${this.baseUrl}/api/tags`);
    if (!response.ok) {
      throw new Error(`Ollama model listing failed with HTTP ${response.status}.`);
    }

    const data = (await response.json()) as OllamaTagsResponse;
    return (data.models ?? []).map((model) => ({
      id: model.name,
      displayName: model.name,
      provider: this.provider
    }));
  }
}
