import { describe, expect, it } from "vitest";
import {
  BuildrCore,
  MainAgentSession,
  TokenBudgetExceededError,
  TokenBudgetTracker,
  compactAgentContext,
  type ChatRequest,
  type ModelAdapter,
  type ModelCapabilities,
  type ModelDelta,
  type TokenCountInput,
  type TokenCountResult
} from "../src/index.js";

class MockModelAdapter implements ModelAdapter {
  readonly id = "mock";
  readonly displayName = "Mock";
  readonly provider = "ollama";
  requests: ChatRequest[] = [];

  constructor(private readonly responseForPath: (path: string) => string, private readonly tokenCount = 10) {}

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

  async *chat(request: ChatRequest): AsyncIterable<ModelDelta> {
    this.requests.push(request);
    const user = request.messages.find((message) => message.role === "user")?.content ?? "";
    const path = /File: (.+)/u.exec(user)?.[1] ?? "unknown";
    yield { type: "text", content: this.responseForPath(path) };
    yield { type: "done" };
  }

  async countTokens(_input: TokenCountInput): Promise<TokenCountResult> {
    return { tokens: this.tokenCount, approximate: true };
  }
}

describe("MainAgentSession", () => {
  it("runs sub-agents and returns patch proposals with token budget state", async () => {
    const model = new MockModelAdapter((path) => JSON.stringify({
      summary: `Updated ${path}.`,
      updatedContent: `updated ${path}\n`
    }), 5);
    const session = new MainAgentSession({
      core: new BuildrCore({ model }),
      modelId: "mock",
      goal: "Update files",
      tasks: [
        { id: "a", title: "Update A", path: "a.ts", currentContent: "old a\n" },
        { id: "b", title: "Update B", path: "b.ts", currentContent: "old b\n" }
      ],
      maxParallelSubAgents: 2,
      tokenBudget: {
        hardTokenCap: 100,
        costRate: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 }
      }
    });

    const report = await session.run();

    expect(report.subAgents.map((agent) => agent.status)).toEqual(["completed", "completed"]);
    expect(report.patchProposals.map((patch) => patch.path)).toEqual(["a.ts", "b.ts"]);
    expect(report.tokenBudget.totalTokens).toBe(20);
    expect(report.tokenBudget.estimatedCostUsd).toBeGreaterThan(0);
  });

  it("blocks before model calls that exceed the hard cap", async () => {
    const model = new MockModelAdapter(() => JSON.stringify({
      summary: "Noop",
      updatedContent: "noop\n"
    }), 50);
    const tracker = new TokenBudgetTracker({ hardTokenCap: 10 });

    await expect(tracker.prepareModelCall({
      adapter: model,
      modelId: "mock",
      label: "test",
      messages: [{ role: "user", content: "large prompt" }]
    })).rejects.toBeInstanceOf(TokenBudgetExceededError);

    expect(model.requests).toHaveLength(0);
    expect(tracker.snapshot().blocked).toBe(true);
  });

  it("compacts older chat context and reports omitted content", () => {
    const compacted = compactAgentContext({
      goal: "Do work",
      contextSummary: "workspace",
      transcript: [
        { role: "user", text: "x".repeat(2000) },
        { role: "assistant", text: "latest" }
      ],
      maxChars: 500
    });

    expect(compacted.text).toContain("Current goal: Do work");
    expect(compacted.text).toContain("latest");
    expect(compacted.omittedMessages).toBeGreaterThan(0);
  });
});
