import { describe, expect, it } from "vitest";
import { LocalTransformersEmbeddingsAdapter } from "../src/embeddings/localTransformers.js";
import { LMStudioOpenAIEmbeddingsAdapter } from "../src/embeddings/lmStudioOpenAI.js";
import { OllamaEmbeddingsAdapter } from "../src/embeddings/ollama.js";
import { assessRemoteCompatibility, detectBuildrEnvironment } from "../src/runtime/remoteCompatibility.js";

describe("Phase 4 embeddings and compatibility", () => {
  it("returns empty local embeddings without loading a model", async () => {
    const adapter = new LocalTransformersEmbeddingsAdapter();

    const result = await adapter.embed({ texts: [] });

    expect(result.vectors).toEqual([]);
    expect(result.dimensions).toBe(0);
  });

  it("defines provider embedding adapters", () => {
    expect(new OllamaEmbeddingsAdapter().id).toBe("ollama");
    expect(new LMStudioOpenAIEmbeddingsAdapter().id).toBe("lmstudio-openai");
  });

  it("detects remote environments and localhost model warnings", () => {
    const report = assessRemoteCompatibility({
      remoteName: "ssh-remote",
      modelBaseUrl: "http://127.0.0.1:11434",
      isTrusted: true
    });

    expect(detectBuildrEnvironment({ env: { CODESPACES: "true" } })).toBe("codespaces");
    expect(report.environment).toBe("remote-ssh");
    expect(report.checks.some((check) => check.id === "localhost-model-endpoint" && !check.ok)).toBe(true);
  });
});
