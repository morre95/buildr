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

export interface LMStudioNativeAdapterOptions {
  baseUrl?: string;
}

export class LMStudioNativeAdapter implements ModelAdapter {
  readonly id = "lmstudio-native";
  readonly displayName = "LM Studio Native";
  readonly provider = "lmstudio-native";

  constructor(private readonly options: LMStudioNativeAdapterOptions = {}) {}

  async getCapabilities(): Promise<ModelCapabilities> {
    return {
      nativeTools: false,
      parallelTools: false,
      streamingToolCalls: false,
      structuredOutput: false,
      jsonSchemaOutput: false,
      thinking: false,
      images: false,
      embeddings: false
    };
  }

  async *chat(_request: ChatRequest, _options: ChatOptions = {}): AsyncIterable<ModelDelta> {
    const baseUrl = this.options.baseUrl ?? "http://127.0.0.1:1234";
    throw new Error(`LM Studio native adapter is a Phase 1B skeleton. Configure OpenAI-compatible mode instead: ${baseUrl}`);
  }

  async countTokens(input: TokenCountInput): Promise<TokenCountResult> {
    const chars = input.messages.reduce((total, message) => total + message.content.length, 0);
    return { tokens: Math.ceil(chars / 4), approximate: true };
  }

  async listModels(): Promise<ModelInfo[]> {
    return [];
  }
}
