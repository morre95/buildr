import { dimensionsFor, type EmbeddingRequest, type EmbeddingResult, type EmbeddingsAdapter } from "./types.js";

type TransformersPipeline = (
  task: "feature-extraction",
  model: string,
  options?: { dtype?: string; device?: string }
) => Promise<(texts: string[], options: { pooling: "mean"; normalize: boolean }) => Promise<{ tolist(): number[][] }>>;

interface TransformersModule {
  pipeline: TransformersPipeline;
}

export interface LocalTransformersEmbeddingsOptions {
  model?: string;
  dtype?: string;
  device?: string;
}

const DEFAULT_MODEL = "Xenova/all-MiniLM-L6-v2";

export class LocalTransformersEmbeddingsAdapter implements EmbeddingsAdapter {
  readonly id = "local-transformers";
  readonly displayName = "Local Transformers.js";

  private readonly defaultModel: string;
  private readonly dtype: string | undefined;
  private readonly device: string | undefined;

  constructor(options: LocalTransformersEmbeddingsOptions = {}) {
    this.defaultModel = options.model ?? DEFAULT_MODEL;
    this.dtype = options.dtype;
    this.device = options.device;
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    if (request.texts.length === 0) {
      return { vectors: [], model: request.model ?? this.defaultModel, dimensions: 0 };
    }

    const model = request.model ?? this.defaultModel;
    const transformers = await loadTransformers();
    const extractor = await transformers.pipeline("feature-extraction", model, {
      ...(this.dtype === undefined ? {} : { dtype: this.dtype }),
      ...(this.device === undefined ? {} : { device: this.device })
    });
    if (request.signal?.aborted) {
      throw new Error("Embedding request was cancelled before inference started.");
    }
    const output = await extractor(request.texts, { pooling: "mean", normalize: true });
    const vectors = output.tolist();
    return { vectors, model, dimensions: dimensionsFor(vectors) };
  }
}

async function loadTransformers(): Promise<TransformersModule> {
  try {
    const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<TransformersModule>;
    return await dynamicImport("@huggingface/transformers");
  } catch (error) {
    throw new Error(`Local embeddings require @huggingface/transformers to be installed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
