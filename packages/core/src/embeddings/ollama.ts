import { dimensionsFor, normalizeVector, type EmbeddingRequest, type EmbeddingResult, type EmbeddingsAdapter } from "./types.js";

interface OllamaEmbedResponse {
  embeddings?: number[][];
}

export interface OllamaEmbeddingsOptions {
  baseUrl?: string;
  model?: string;
}

export class OllamaEmbeddingsAdapter implements EmbeddingsAdapter {
  readonly id = "ollama";
  readonly displayName = "Ollama Embeddings";

  private readonly baseUrl: string;
  private readonly defaultModel: string;

  constructor(options: OllamaEmbeddingsOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "http://127.0.0.1:11434").replace(/\/$/u, "");
    this.defaultModel = options.model ?? "nomic-embed-text";
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

    const response = await fetch(`${this.baseUrl}/api/embed`, init);
    if (!response.ok) {
      throw new Error(`Ollama embeddings failed with HTTP ${response.status}.`);
    }
    const data = (await response.json()) as OllamaEmbedResponse;
    const vectors = (data.embeddings ?? []).map(normalizeVector);
    return { vectors, model, dimensions: dimensionsFor(vectors) };
  }
}
