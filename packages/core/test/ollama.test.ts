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
