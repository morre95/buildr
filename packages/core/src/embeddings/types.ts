export interface EmbeddingRequest {
  texts: string[];
  model?: string;
  signal?: AbortSignal;
}

export interface EmbeddingResult {
  vectors: number[][];
  model: string;
  dimensions: number;
}

export interface EmbeddingsAdapter {
  readonly id: string;
  readonly displayName: string;
  embed(request: EmbeddingRequest): Promise<EmbeddingResult>;
}

export function normalizeVector(vector: number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (magnitude === 0) {
    return vector;
  }
  return vector.map((value) => value / magnitude);
}

export function dimensionsFor(vectors: number[][]): number {
  return vectors[0]?.length ?? 0;
}
