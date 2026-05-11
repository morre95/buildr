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

interface OpenAICompatibleModelList {
  data?: Array<{
    id: string;
  }>;
}

interface OpenAICompatibleChatChunk {
  choices?: Array<{
    delta?: {
      content?: string;
    };
    finish_reason?: string | null;
  }>;
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
        messages: request.messages,
        stream: true,
        temperature: request.temperature ?? 0.1,
        tools: request.tools
      })
    };
    if (options.signal !== undefined) {
      init.signal = options.signal;
    }

    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, init);
    if (!response.ok || response.body === null) {
      throw new Error(`LM Studio chat failed with HTTP ${response.status}.`);
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
        if (!trimmed.startsWith("data:")) {
          continue;
        }
        const data = trimmed.slice("data:".length).trim();
        if (data === "[DONE]") {
          yield { type: "done" };
          continue;
        }
        const parsed = JSON.parse(data) as OpenAICompatibleChatChunk;
        const content = parsed.choices?.[0]?.delta?.content;
        if (content !== undefined) {
          yield { type: "text", content };
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
