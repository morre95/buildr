import { describe, expect, it } from "vitest";
import {
  BuildrCore,
  LM_STUDIO_CONTEXT_SLOT_DIAGNOSTIC,
  MainAgentSession,
  ProviderError,
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

  constructor(private readonly responseForPath: (path: string, request: ChatRequest) => string, private readonly tokenCount = 10) {}

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
    yield { type: "text", content: this.responseForPath(path, request) };
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

  it("keeps sub-agent prompts focused and marks empty targets as new-file work", async () => {
    const model = new MockModelAdapter((path) => JSON.stringify({
      summary: `Created ${path}.`,
      updatedContent: `new ${path}\n`
    }), 5);
    const session = new MainAgentSession({
      core: new BuildrCore({ model }),
      modelId: "mock",
      goal: "Split @snake.html into files",
      contextSummary: "GLOBAL WORKSPACE CONTEXT SHOULD NOT BE SENT TO SUB AGENTS",
      transcript: [{ role: "user", text: "OLD CHAT SHOULD NOT BE SENT TO SUB AGENTS" }],
      tasks: [{
        id: "css",
        title: "Create CSS",
        path: "snake.css",
        currentContent: "",
        contextSummary: "Source excerpt from snake.html",
        consultedFiles: ["snake.html"]
      }],
      maxParallelSubAgents: 1,
      tokenBudget: { hardTokenCap: 100 }
    });

    const report = await session.run();
    const combinedPrompt = model.requests[0]!.messages.map((message) => message.content).join("\n");

    expect(report.subAgents[0]!.status).toBe("completed");
    expect(combinedPrompt).toContain("The target file is empty or missing");
    expect(combinedPrompt).toContain("The target file is empty or does not exist yet");
    expect(combinedPrompt).toContain("Source excerpt from snake.html");
    expect(combinedPrompt).toContain("Consulted files:\n- snake.html");
    expect(combinedPrompt).not.toContain("GLOBAL WORKSPACE CONTEXT SHOULD NOT BE SENT");
    expect(combinedPrompt).not.toContain("OLD CHAT SHOULD NOT BE SENT");
    expect(combinedPrompt).not.toContain("Compacted main-agent context");
  });

  it("retries provider context failures once with compact context", async () => {
    let calls = 0;
    const model = new MockModelAdapter((path, request) => {
      calls += 1;
      if (calls === 1) {
        throw new ProviderError("Context size has been exceeded.", "context");
      }
      const prompt = request.messages.map((message) => message.content).join("\n");
      expect(prompt).toContain("Retry mode: use compact context only");
      return JSON.stringify({
        summary: `Retried ${path}.`,
        updatedContent: "updated\n"
      });
    }, 5);
    const session = new MainAgentSession({
      core: new BuildrCore({ model }),
      modelId: "mock",
      goal: "Update files",
      tasks: [{
        id: "a",
        title: "Update A",
        path: "a.ts",
        currentContent: "old\n",
        contextSummary: "x".repeat(4000)
      }],
      maxParallelSubAgents: 3,
      tokenBudget: { hardTokenCap: 100 }
    });

    const report = await session.run();

    expect(model.requests).toHaveLength(2);
    expect(report.subAgents[0]!.status).toBe("completed");
    expect(report.patchProposals).toHaveLength(1);
    expect(report.warnings.join("\n")).toContain("Retried a serially with compact context");
  });

  it("keeps real provider error and diagnostics when compact retry fails", async () => {
    const model = new MockModelAdapter(() => {
      throw new ProviderError("KV cache is full.", "context");
    }, 5);
    const session = new MainAgentSession({
      core: new BuildrCore({ model }),
      modelId: "mock",
      goal: "Update files",
      tasks: [{ id: "a", title: "Update A", path: "a.ts", currentContent: "old\n" }],
      maxParallelSubAgents: 2,
      tokenBudget: { hardTokenCap: 100 }
    });

    const report = await session.run();

    expect(model.requests).toHaveLength(2);
    expect(report.subAgents[0]!.status).toBe("failed");
    expect(report.subAgents[0]!.summary).toBe("KV cache is full.");
    expect(report.warnings).toContain("KV cache is full.");
    expect(report.warnings).toContain(LM_STUDIO_CONTEXT_SLOT_DIAGNOSTIC);
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
