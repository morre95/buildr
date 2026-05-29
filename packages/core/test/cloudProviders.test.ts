import { afterEach, describe, expect, it, vi } from "vitest";
import { AnthropicAdapter, BuildrCore, OpenAIAdapter, OpenAICompatibleAdapter, OpenRouterAdapter } from "../src/index.js";

describe("cloud provider adapters", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates concrete adapters for OpenAI, OpenRouter, and Anthropic", () => {
    expect(BuildrCore.createModelAdapter({ provider: "openai" }).provider).toBe("openai");
    expect(BuildrCore.createModelAdapter({ provider: "openrouter" }).provider).toBe("openrouter");
    expect(BuildrCore.createModelAdapter({ provider: "anthropic" }).provider).toBe("anthropic");
  });

  it("sends OpenAI chat requests with bearer auth", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    stubJsonFetch(requests, [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "hi" }, finish_reason: null }] })}\n\n`,
      "data: [DONE]\n\n"
    ]);
    const adapter = new OpenAIAdapter({ apiKey: "sk-test" });

    const chunks: string[] = [];
    for await (const delta of adapter.chat({ model: "gpt-test", messages: [{ role: "user", content: "hello" }] })) {
      if (delta.type === "text") {
        chunks.push(delta.content ?? "");
      }
    }

    expect(requests[0]!.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(requests[0]!.init.headers).toMatchObject({ authorization: "Bearer sk-test" });
    expect(JSON.parse(requests[0]!.init.body as string)).not.toHaveProperty("temperature");
    expect(chunks).toEqual(["hi"]);
  });

  it("uses OpenRouter endpoint and attribution headers", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    stubJsonFetch(requests, ["data: [DONE]\n\n"]);
    const adapter = new OpenRouterAdapter({ apiKey: "or-test" });

    for await (const _delta of adapter.chat({ model: "openai/gpt-test", messages: [] })) {
      // Exhaust stream.
    }

    expect(requests[0]!.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(requests[0]!.init.headers).toMatchObject({
      authorization: "Bearer or-test",
      "HTTP-Referer": "https://github.com/buildr",
      "X-OpenRouter-Title": "Buildr"
    });
    expect(JSON.parse(requests[0]!.init.body as string)).not.toHaveProperty("temperature");
  });

  it("retries OpenAI-compatible requests without temperature when a model rejects it", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      if (requests.length === 1) {
        return new Response(JSON.stringify({
          error: { message: "Unsupported value: 'temperature' does not support 0.1 with this model. Only the default (1) value is supported." }
        }), { status: 400 });
      }
      return new Response(new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: null }] })}\n\n`));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        }
      }), { status: 200 });
    }));
    const adapter = new OpenAICompatibleAdapter({ baseUrl: "https://example.test", apiKey: "key" });

    const chunks: string[] = [];
    for await (const delta of adapter.chat({ model: "reasoning-model", messages: [] })) {
      if (delta.type === "text") {
        chunks.push(delta.content ?? "");
      }
    }

    expect(JSON.parse(requests[0]!.init.body as string)).toHaveProperty("temperature", 0.1);
    expect(JSON.parse(requests[1]!.init.body as string)).not.toHaveProperty("temperature");
    expect(chunks).toEqual(["ok"]);
  });

  it("emits Anthropic streamed tool calls", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode([
          `event: content_block_start`,
          `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_01", name: "read_file" } })}`,
          "",
          `event: content_block_delta`,
          `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"path\":" } })}`,
          "",
          `event: content_block_delta`,
          `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "\"README.md\"}" } })}`,
          "",
          `event: content_block_stop`,
          `data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
          "",
          `event: message_stop`,
          `data: ${JSON.stringify({ type: "message_stop" })}`,
          ""
        ].join("\n")));
        controller.close();
      }
    }), { status: 200 })));
    const adapter = new AnthropicAdapter({ apiKey: "anth-test" });

    const toolCalls = [];
    for await (const delta of adapter.chat({ model: "claude-test", messages: [{ role: "user", content: "read the readme" }], tools: [{ name: "read_file", description: "Read file", inputSchema: { type: "object" }, permission: "auto_allow" }] })) {
      if (delta.type === "tool_call") {
        toolCalls.push(delta.toolCall);
      }
    }

    expect(toolCalls).toEqual([{ id: "toolu_01", name: "read_file", arguments: { path: "README.md" } }]);
  });

  it("sends Anthropic tool results as tool_result content blocks", async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      return new Response(new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "done" } })}\n\n`));
          controller.enqueue(encoder.encode(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`));
          controller.close();
        }
      }), { status: 200 });
    }));
    const adapter = new AnthropicAdapter({ apiKey: "anth-test" });

    for await (const _delta of adapter.chat({
      model: "claude-test",
      messages: [
        { role: "user", content: "read it" },
        { role: "assistant", content: "", toolCalls: [{ id: "toolu_01", name: "read_file", arguments: { path: "a.ts" } }] },
        { role: "tool", content: "file contents here", toolCallId: "toolu_01", name: "read_file" }
      ]
    })) {
      // Exhaust stream.
    }

    const body = JSON.parse(requests[0]!.init?.body as string);
    const assistantMsg = body.messages.find((m: Record<string, unknown>) => m.role === "assistant");
    expect(assistantMsg.content).toEqual([{ type: "tool_use", id: "toolu_01", name: "read_file", input: { path: "a.ts" } }]);
    const toolResultMsg = body.messages.find((m: Record<string, unknown>) => m.role === "user" && Array.isArray(m.content));
    expect(toolResultMsg.content).toEqual([{ type: "tool_result", tool_use_id: "toolu_01", content: "file contents here" }]);
  });

  it("lists Anthropic models and streams text deltas", async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      if (url.endsWith("/v1/models")) {
        return new Response(JSON.stringify({ data: [{ id: "claude-test", display_name: "Claude Test" }] }), { status: 200 });
      }
      return new Response(new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "hello" } })}\n\n`));
          controller.enqueue(encoder.encode(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`));
          controller.close();
        }
      }), { status: 200 });
    }));
    const adapter = new AnthropicAdapter({ apiKey: "anth-test" });

    await expect(adapter.listModels()).resolves.toEqual([{ id: "claude-test", displayName: "Claude Test", provider: "anthropic" }]);
    const chunks: string[] = [];
    for await (const delta of adapter.chat({ model: "claude-test", messages: [{ role: "system", content: "sys" }, { role: "user", content: "hi" }] })) {
      if (delta.type === "text") {
        chunks.push(delta.content ?? "");
      }
    }

    expect(requests[0]!.init?.headers).toMatchObject({ "x-api-key": "anth-test", "anthropic-version": "2023-06-01" });
    expect(requests[1]!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(JSON.parse(requests[1]!.init?.body as string)).toMatchObject({ system: "sys", stream: true });
    expect(chunks).toEqual(["hello"]);
  });

  it("reads the OpenRouter context window from /v1/models", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({ data: [
        { id: "other/model", context_length: 8192 },
        { id: "anthropic/claude", context_length: 200000 }
      ] }), { status: 200 });
    }));
    const adapter = new OpenRouterAdapter({ apiKey: "or-test" });

    expect(await adapter.getContextWindow("anthropic/claude")).toBe(200000);
    expect(requests[0]!.url).toBe("https://openrouter.ai/api/v1/models");
  });

  it("resolves OpenAI context windows from published per-model values", async () => {
    const adapter = new OpenAIAdapter({ apiKey: "sk-test" });

    expect(await adapter.getContextWindow("gpt-4o-mini")).toBe(128000);
    expect(await adapter.getContextWindow("gpt-4.1")).toBe(1047576);
    expect(await adapter.getContextWindow("o3-mini")).toBe(200000);
    expect(await adapter.getContextWindow("unknown-model")).toBeUndefined();
  });
});

function stubJsonFetch(requests: Array<{ url: string; init: RequestInit }>, chunks: string[]): void {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    return new Response(new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      }
    }), { status: 200 });
  }));
}
