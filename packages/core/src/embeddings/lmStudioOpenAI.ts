import { dimensionsFor, normalizeVector, type EmbeddingRequest, type EmbeddingResult, type EmbeddingsAdapter } from "./types.js";

interface OpenAIEmbeddingResponse {
  data?: Array<{
    embedding: number[];
  }>;
}

export interface LMStudioOpenAIEmbeddingsOptions {
  baseUrl?: string;
  model?: string;
}

export class LMStudioOpenAIEmbeddingsAdapter implements EmbeddingsAdapter {
  readonly id = "lmstudio-openai";
  readonly displayName = "LM Studio OpenAI-Compatible Embeddings";

  private readonly baseUrl: string;
  private readonly defaultModel: string;

  constructor(options: LMStudioOpenAIEmbeddingsOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "http://127.0.0.1:1234").replace(/\/$/u, "");
    this.defaultModel = options.model ?? "text-embedding-nomic-embed-text-v1.5";
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    const model = request.model ?? this.defaultModel;
    const init: RequestInit = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, input: request.texts })
    };
    if (request.signal !== undefined) {
      init.signal = request.signal;
    }

    const response = await fetch(`${this.baseUrl}/v1/embeddings`, init);
    if (!response.ok) {
      throw new Error(`LM Studio embeddings failed with HTTP ${response.status}.`);
    }
    const data = (await response.json()) as OpenAIEmbeddingResponse;
    const vectors = (data.data ?? []).map((item) => normalizeVector(item.embedding));
    return { vectors, model, dimensions: dimensionsFor(vectors) };
  }
}
