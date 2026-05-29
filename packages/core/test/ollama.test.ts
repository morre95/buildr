import { afterEach, describe, expect, it, vi } from "vitest";
import { OllamaAdapter } from "../src/index.js";

describe("OllamaAdapter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("emits chat tool calls", async () => {
    stubStream([
      `${JSON.stringify({ message: { tool_calls: [{ function: { name: "search_codebase", arguments: { query: "Buildr" } } }] }, done: true })}\n`
    ]);
    const adapter = new OllamaAdapter();

    const toolCalls = [];
    for await (const delta of adapter.chat({ model: "local", messages: [], tools: [{ name: "search_codebase", description: "Search", inputSchema: { type: "object" }, permission: "auto_allow" }] })) {
      if (delta.type === "tool_call") {
        toolCalls.push(delta.toolCall);
      }
    }

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({ name: "search_codebase", arguments: { query: "Buildr" } });
  });

  it("reads the context window from /api/show model_info", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ model_info: { "general.architecture": "qwen2", "qwen2.context_length": 32768 } }),
      { status: 200 }
    )));
    const adapter = new OllamaAdapter();

    expect(await adapter.getContextWindow("qwen2.5-coder")).toBe(32768);
  });

  it("returns undefined when /api/show has no context length", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ model_info: {} }), { status: 200 })));
    const adapter = new OllamaAdapter();

    expect(await adapter.getContextWindow("local")).toBeUndefined();
  });
});

function stubStream(chunks: string[]): void {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    }
  }), { status: 200 })));
}
