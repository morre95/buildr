import { describe, expect, it } from "vitest";
import {
  ToolCallingSession,
  ToolRegistry,
  TokenBudgetTracker,
  type ToolHandler
} from "../src/index.js";
import type {
  ChatOptions,
  ChatRequest,
  ModelAdapter,
  ModelCapabilities,
  ModelDelta,
  ToolCall,
  ToolDefinition,
  ToolResult
} from "../src/index.js";

class ScriptedAdapter implements ModelAdapter {
  readonly id = "scripted";
  readonly displayName = "Scripted";
  readonly provider = "ollama" as const;
  chatCalls = 0;
  lastTools: ToolDefinition[] = [];

  constructor(private readonly turns: ModelDelta[][]) {}

  async getCapabilities(): Promise<ModelCapabilities> {
    return {
      nativeTools: true,
      parallelTools: true,
      streamingToolCalls: true,
      structuredOutput: true,
      jsonSchemaOutput: false,
      thinking: false,
      images: false,
      embeddings: false
    };
  }

  async *chat(request: ChatRequest, _options: ChatOptions = {}): AsyncIterable<ModelDelta> {
    this.lastTools = request.tools ?? [];
    const turn = this.turns[this.chatCalls] ?? [{ type: "done" }];
    this.chatCalls += 1;
    for (const delta of turn) {
      yield delta;
    }
  }

  async countTokens(input: { messages: ChatRequest["messages"] }): Promise<{ tokens: number; approximate: boolean }> {
    const chars = input.messages.reduce((total, message) => total + message.content.length, 0);
    return { tokens: Math.ceil(chars / 4) + 1, approximate: true };
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function textDelta(content: string): ModelDelta {
  return { type: "text", content };
}

function toolCallDelta(id: string, name: string, args: Record<string, unknown> = {}): ModelDelta {
  return { type: "tool_call", toolCall: { id, name, arguments: args } };
}

function definition(name: string, permission: ToolDefinition["permission"]): ToolDefinition {
  return { name, description: `${name} tool`, inputSchema: { type: "object" }, permission };
}

function okResult(summary: string): ToolResult {
  return { ok: true, summary, warnings: [], provenance: [] };
}

function seedMessages(task: string): ChatRequest["messages"] {
  return [
    { role: "system", content: "You are a test agent." },
    { role: "user", content: task }
  ];
}

describe("ToolCallingSession", () => {
  it("runs independent read-only tool calls in parallel and feeds results back", async () => {
    const started = [deferred<void>(), deferred<void>()];
    const release = deferred<void>();
    let index = 0;
    const handler: ToolHandler = async (call) => {
      const slot = index;
      index += 1;
      started[slot]!.resolve();
      await release.promise;
      return okResult(`read ${call.arguments.path}`);
    };
    const registry = new ToolRegistry().register({ definition: definition("read_file", "auto_allow"), handler });
    const adapter = new ScriptedAdapter([
      [toolCallDelta("c1", "read_file", { path: "a.ts" }), toolCallDelta("c2", "read_file", { path: "b.ts" }), { type: "done" }],
      [textDelta("Both files read."), { type: "done" }]
    ]);
    const session = new ToolCallingSession({ adapter, modelId: "test", messages: seedMessages("read both"), registry });

    const runPromise = session.run();
    await Promise.all(started.map((d) => d.promise)); // both must start before either is released
    release.resolve();
    const report = await runPromise;

    expect(report.stoppedReason).toBe("completed");
    expect(report.finalText).toBe("Both files read.");
    expect(report.toolExecutions).toHaveLength(2);
    expect(report.toolExecutions.every((execution) => execution.ranInParallel)).toBe(true);
    const toolMessages = report.messages.filter((message) => message.role === "tool");
    expect(toolMessages.map((message) => message.toolCallId)).toEqual(["c1", "c2"]);
    expect(adapter.chatCalls).toBe(2);
  });

  it("serializes approval-gated tools and runs read-only tools in parallel within the same turn", async () => {
    const order: string[] = [];
    const readHandler: ToolHandler = async () => {
      order.push("read");
      return okResult("read");
    };
    const writeHandler: ToolHandler = async () => {
      order.push("write");
      return okResult("written");
    };
    const registry = new ToolRegistry()
      .register({ definition: definition("read_file", "auto_allow"), handler: readHandler })
      .register({ definition: definition("apply_patch", "require_approval"), handler: writeHandler });
    const adapter = new ScriptedAdapter([
      [toolCallDelta("r1", "read_file"), toolCallDelta("w1", "apply_patch"), { type: "done" }],
      [textDelta("done"), { type: "done" }]
    ]);
    const session = new ToolCallingSession({
      adapter,
      modelId: "test",
      messages: seedMessages("edit"),
      registry,
      requestApproval: async () => "allow"
    });

    const report = await session.run();

    const read = report.toolExecutions.find((execution) => execution.call.name === "read_file");
    const write = report.toolExecutions.find((execution) => execution.call.name === "apply_patch");
    expect(read?.ranInParallel).toBe(true);
    expect(write?.ranInParallel).toBe(false);
    expect(order).toContain("write");
  });

  it("denies approval-gated tools when no approver is provided and reports it to the model", async () => {
    const registry = new ToolRegistry().register({
      definition: definition("apply_patch", "require_approval"),
      handler: async () => okResult("written")
    });
    const adapter = new ScriptedAdapter([
      [toolCallDelta("w1", "apply_patch"), { type: "done" }],
      [textDelta("ok"), { type: "done" }]
    ]);
    const session = new ToolCallingSession({ adapter, modelId: "test", messages: seedMessages("edit"), registry });

    const report = await session.run();

    const write = report.toolExecutions.find((execution) => execution.call.name === "apply_patch");
    expect(write?.decision).toBe("deny");
    expect(write?.result.ok).toBe(false);
    const toolMessage = report.messages.find((message) => message.role === "tool" && message.toolCallId === "w1");
    expect(toolMessage?.content).toContain("approval");
  });

  it("returns an error result for unknown tools without aborting the loop", async () => {
    const registry = new ToolRegistry();
    const adapter = new ScriptedAdapter([
      [toolCallDelta("u1", "mystery_tool"), { type: "done" }],
      [textDelta("recovered"), { type: "done" }]
    ]);
    const session = new ToolCallingSession({ adapter, modelId: "test", messages: seedMessages("go"), registry });

    const report = await session.run();

    expect(report.stoppedReason).toBe("completed");
    expect(report.finalText).toBe("recovered");
    const execution = report.toolExecutions[0];
    expect(execution?.result.ok).toBe(false);
    expect(execution?.result.summary).toContain("Unknown tool");
  });

  it("converts a throwing handler into a tool result instead of failing the loop", async () => {
    const registry = new ToolRegistry().register({
      definition: definition("read_file", "auto_allow"),
      handler: async () => {
        throw new Error("disk on fire");
      }
    });
    const adapter = new ScriptedAdapter([
      [toolCallDelta("c1", "read_file"), { type: "done" }],
      [textDelta("handled"), { type: "done" }]
    ]);
    const session = new ToolCallingSession({ adapter, modelId: "test", messages: seedMessages("read"), registry });

    const report = await session.run();

    expect(report.finalText).toBe("handled");
    expect(report.toolExecutions[0]?.result.ok).toBe(false);
    expect(report.toolExecutions[0]?.result.summary).toContain("disk on fire");
  });

  it("stops after the iteration limit when the model keeps requesting tools", async () => {
    const registry = new ToolRegistry().register({
      definition: definition("read_file", "auto_allow"),
      handler: async () => okResult("read")
    });
    const adapter = new ScriptedAdapter([
      [toolCallDelta("a", "read_file"), { type: "done" }],
      [toolCallDelta("b", "read_file"), { type: "done" }],
      [toolCallDelta("c", "read_file"), { type: "done" }]
    ]);
    const session = new ToolCallingSession({
      adapter,
      modelId: "test",
      messages: seedMessages("loop"),
      registry,
      maxIterations: 2
    });

    const report = await session.run();

    expect(report.iterations).toBe(2);
    expect(report.stoppedReason).toBe("max_iterations");
    expect(report.warnings.some((warning) => warning.includes("iteration limit"))).toBe(true);
  });

  it("tracks token usage through the supplied budget", async () => {
    const registry = new ToolRegistry().register({
      definition: definition("read_file", "auto_allow"),
      handler: async () => okResult("read")
    });
    const adapter = new ScriptedAdapter([
      [toolCallDelta("c1", "read_file"), { type: "done" }],
      [textDelta("complete"), { type: "done" }]
    ]);
    const budget = new TokenBudgetTracker({
      hardTokenCap: 100000,
      warningThresholds: [0.9],
      costRate: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 }
    });
    const session = new ToolCallingSession({ adapter, modelId: "test", messages: seedMessages("read"), registry, budget });

    const report = await session.run();

    expect(report.tokenBudget?.totalTokens).toBeGreaterThan(0);
    expect(report.tokenBudget?.inputTokens).toBeGreaterThan(0);
  });
});
