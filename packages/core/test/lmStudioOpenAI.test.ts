import { afterEach, describe, expect, it, vi } from "vitest";
import { LM_STUDIO_CONTEXT_SLOT_DIAGNOSTIC, LMStudioOpenAIAdapter } from "../src/index.js";

describe("LMStudioOpenAIAdapter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("streams OpenAI-compatible text chunks", async () => {
    stubStream([
      `data: ${JSON.stringify({ choices: [{ delta: { content: "hello" }, finish_reason: null }] })}\n\n`,
      "data: [DONE]\n\n"
    ]);
    const adapter = new LMStudioOpenAIAdapter();

    const chunks: string[] = [];
    for await (const delta of adapter.chat({ model: "local", messages: [] })) {
      if (delta.type === "text") {
        chunks.push(delta.content ?? "");
      }
    }

    expect(chunks).toEqual(["hello"]);
  });

  it("throws streamed OpenAI-compatible error payload messages", async () => {
    stubStream([
      `data: ${JSON.stringify({ error: { message: "Context size has been exceeded." } })}\n\n`
    ]);
    const adapter = new LMStudioOpenAIAdapter();

    await expect(collect(adapter)).rejects.toThrow("Context size has been exceeded.");
  });

  it("emits streamed tool call chunks", async () => {
    stubStream([
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read_file", arguments: "{\"path\":" } }] }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "\"README.md\"}" } }] }, finish_reason: "tool_calls" }] })}\n\n`,
      "data: [DONE]\n\n"
    ]);
    const adapter = new LMStudioOpenAIAdapter();

    const toolCalls = [];
    for await (const delta of adapter.chat({ model: "local", messages: [], tools: [{ name: "read_file", description: "Read file", inputSchema: { type: "object" }, permission: "auto_allow" }] })) {
      if (delta.type === "tool_call") {
        toolCalls.push(delta.toolCall);
      }
    }

    expect(toolCalls).toEqual([{ id: "call_1", name: "read_file", arguments: { path: "README.md" } }]);
  });

  it("throws non-stream HTTP error payload messages", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: { message: "Context size has been exceeded." }
    }), { status: 400 })));
    const adapter = new LMStudioOpenAIAdapter();

    await expect(collect(adapter)).rejects.toThrow("Context size has been exceeded.");
  });

  it("throws SSE error event payload messages", async () => {
    stubStream([
      "event: error\n",
      `data: ${JSON.stringify({ message: "KV cache is full." })}\n\n`
    ]);
    const adapter = new LMStudioOpenAIAdapter();

    await expect(collect(adapter)).rejects.toThrow("KV cache is full.");
  });

  it("emits parallel tool calls with different indices", async () => {
    stubStream([
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_a", function: { name: "read_file", arguments: "{\"path\":\"a.ts\"}" } }] }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 1, id: "call_b", function: { name: "search_codebase", arguments: "{\"query\":\"hello\"}" } }] }, finish_reason: "tool_calls" }] })}\n\n`,
      "data: [DONE]\n\n"
    ]);
    const adapter = new LMStudioOpenAIAdapter();

    const toolCalls = [];
    for await (const delta of adapter.chat({ model: "local", messages: [], tools: [{ name: "read_file", description: "Read", inputSchema: { type: "object" }, permission: "auto_allow" }, { name: "search_codebase", description: "Search", inputSchema: { type: "object" }, permission: "auto_allow" }] })) {
      if (delta.type === "tool_call") {
        toolCalls.push(delta.toolCall);
      }
    }

    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0]).toMatchObject({ id: "call_a", name: "read_file", arguments: { path: "a.ts" } });
    expect(toolCalls[1]).toMatchObject({ id: "call_b", name: "search_codebase", arguments: { query: "hello" } });
  });

  it("flushes accumulated tool calls when stop is received instead of tool_calls", async () => {
    stubStream([
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_x", function: { name: "read_file", arguments: "{\"path\":\"x.ts\"}" } }] }, finish_reason: "stop" }] })}\n\n`,
      "data: [DONE]\n\n"
    ]);
    const adapter = new LMStudioOpenAIAdapter();

    const toolCalls = [];
    for await (const delta of adapter.chat({ model: "local", messages: [] })) {
      if (delta.type === "tool_call") {
        toolCalls.push(delta.toolCall);
      }
    }

    expect(toolCalls).toEqual([{ id: "call_x", name: "read_file", arguments: { path: "x.ts" } }]);
  });

  it("exports the LM Studio effective context diagnostic", () => {
    expect(LM_STUDIO_CONTEXT_SLOT_DIAGNOSTIC).toContain("n_ctx_slot = 4096");
  });
});

async function collect(adapter: LMStudioOpenAIAdapter): Promise<void> {
  for await (const _delta of adapter.chat({ model: "local", messages: [] })) {
    // Exhaust the stream.
  }
}

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
