import { describe, expect, it } from "vitest";
import { BuildrCore, type ChatRequest, type ModelAdapter, type ModelCapabilities, type ModelDelta, type TokenCountInput, type TokenCountResult } from "../src/index.js";

class MockModelAdapter implements ModelAdapter {
  readonly id = "mock";
  readonly displayName = "Mock";
  readonly provider = "ollama";

  constructor(private readonly response: string | string[], private readonly shouldThrow = false) {}

  async getCapabilities(): Promise<ModelCapabilities> {
    return {
      nativeTools: false,
      parallelTools: false,
      streamingToolCalls: false,
      structuredOutput: true,
      jsonSchemaOutput: false,
      thinking: false,
      images: false,
      embeddings: false
    };
  }

  async *chat(_request: ChatRequest): AsyncIterable<ModelDelta> {
    if (this.shouldThrow) {
      throw new Error("offline");
    }
    for (const content of Array.isArray(this.response) ? this.response : [this.response]) {
      yield { type: "text", content };
    }
    yield { type: "done" };
  }

  async countTokens(_input: TokenCountInput): Promise<TokenCountResult> {
    return { tokens: 1, approximate: true };
  }
}

describe("model-backed Buildr planning", () => {
  it("creates a normalized plan from model JSON", async () => {
    const core = new BuildrCore({
      model: new MockModelAdapter(JSON.stringify({
        goal: "Add tests",
        acceptanceCriteria: ["Tests cover the new path"],
        scopeBoundaries: ["Only edit tests"],
        rulePacks: ["verification"],
        verification: {
          required: true,
          levels: ["tests"],
          commands: ["pnpm test"],
          allowUnverifiedCompletion: "ask",
          includeOutputEvidence: true
        },
        steps: [
          {
            id: "inspect",
            title: "Inspect tests",
            kind: "read",
            tools: ["search_codebase"],
            targets: ["packages/**"],
            dependsOn: [],
            risk: "low"
          }
        ]
      }))
    });

    const result = await core.createPlanFromModel({ goal: "Add tests", modelId: "mock" });

    expect(result.source).toBe("model");
    expect(result.plan.verification.commands).toEqual(["pnpm test"]);
  });

  it("falls back when the model is unavailable", async () => {
    const core = new BuildrCore({ model: new MockModelAdapter("", true) });

    const result = await core.createPlanFromModel({ goal: "Add tests", modelId: "mock" });

    expect(result.source).toBe("fallback");
    expect(result.plan.goal).toBe("Add tests");
    expect(result.warnings[0]).toContain("offline");
  });

  it("reports streamed model deltas while creating a plan", async () => {
    const chunks = [
      "{\"goal\":\"Add tests\",",
      "\"acceptanceCriteria\":[\"Tests cover the new path\"],\"scopeBoundaries\":[\"Only edit tests\"],\"rulePacks\":[\"verification\"],\"verification\":{\"required\":true,\"levels\":[\"tests\"],\"commands\":[\"pnpm test\"],\"allowUnverifiedCompletion\":\"ask\",\"includeOutputEvidence\":true},\"steps\":[{\"id\":\"inspect\",\"title\":\"Inspect tests\",\"kind\":\"read\",\"tools\":[\"search_codebase\"],\"targets\":[\"packages/**\"],\"dependsOn\":[],\"risk\":\"low\"}]}"
    ];
    const deltas: string[] = [];
    const core = new BuildrCore({
      model: new MockModelAdapter(chunks)
    });

    const result = await core.createPlanFromModel({
      goal: "Add tests",
      modelId: "mock",
      onDelta: (content) => deltas.push(content)
    });

    expect(result.source).toBe("model");
    expect(deltas).toEqual(chunks);
  });

  it("parses model file rewrites", async () => {
    const core = new BuildrCore({
      model: new MockModelAdapter(JSON.stringify({
        summary: "Updated greeting.",
        updatedContent: "export const greeting = 'hello';\n"
      }))
    });

    const result = await core.createFileRewriteFromModel({
      goal: "Change greeting",
      modelId: "mock",
      path: "src/greeting.ts",
      currentContent: "export const greeting = 'hi';\n"
    });

    expect(result.summary).toBe("Updated greeting.");
    expect(result.updatedContent).toContain("hello");
  });
});
