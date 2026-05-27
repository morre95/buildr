import { afterEach, describe, expect, it, vi } from "vitest";
import { LMStudioNativeAdapter } from "../src/index.js";

describe("LMStudioNativeAdapter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("streams text from message.delta SSE events", async () => {
    stubStream([
      `data: ${JSON.stringify({ type: "message.delta", delta: { content: "Hello" } })}\n\n`,
      `data: ${JSON.stringify({ type: "message.delta", delta: { content: " world" } })}\n\n`,
      `data: ${JSON.stringify({ type: "chat.end", response: { message: { content: "Hello world" } } })}\n\n`
    ]);
    const adapter = new LMStudioNativeAdapter();

    const chunks: string[] = [];
    let gotDone = false;
    for await (const delta of adapter.chat({ model: "local-model", messages: [{ role: "user", content: "hi" }] })) {
      if (delta.type === "text") {
        chunks.push(delta.content ?? "");
      }
      if (delta.type === "done") {
        gotDone = true;
      }
    }

    expect(chunks).toEqual(["Hello", " world"]);
    expect(gotDone).toBe(true);
  });

  it("includes reasoning.delta as text output", async () => {
    stubStream([
      `data: ${JSON.stringify({ type: "reasoning.delta", delta: { content: "thinking..." } })}\n\n`,
      `data: ${JSON.stringify({ type: "message.delta", delta: { content: "answer" } })}\n\n`,
      `data: ${JSON.stringify({ type: "chat.end" })}\n\n`
    ]);
    const adapter = new LMStudioNativeAdapter();

    const chunks: string[] = [];
    for await (const delta of adapter.chat({ model: "local", messages: [] })) {
      if (delta.type === "text") {
        chunks.push(delta.content ?? "");
      }
    }

    expect(chunks).toEqual(["thinking...", "answer"]);
  });

  it("throws on SSE error events", async () => {
    stubStream([
      `data: ${JSON.stringify({ type: "error", error: { message: "Model not loaded." } })}\n\n`
    ]);
    const adapter = new LMStudioNativeAdapter();

    await expect(collect(adapter)).rejects.toThrow("Model not loaded.");
  });

  it("throws on HTTP error responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: { message: "Invalid model." }
    }), { status: 400 })));
    const adapter = new LMStudioNativeAdapter();

    await expect(collect(adapter)).rejects.toThrow("Invalid model.");
  });

  it("lists models from the native API", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      models: [
        { key: "microsoft/phi-2", display_name: "Phi-2", type: "llm" },
        { key: "mistral/7b", display_name: "Mistral 7B", type: "llm" }
      ]
    }), { status: 200 })));
    const adapter = new LMStudioNativeAdapter();

    const models = await adapter.listModels();

    expect(models).toEqual([
      { id: "microsoft/phi-2", displayName: "Phi-2", provider: "lmstudio-native" },
      { id: "mistral/7b", displayName: "Mistral 7B", provider: "lmstudio-native" }
    ]);
  });

  it("sends system prompt and flattened input", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return new Response(new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "chat.end" })}\n\n`));
          controller.close();
        }
      }), { status: 200 });
    }));
    const adapter = new LMStudioNativeAdapter();

    for await (const _delta of adapter.chat({
      model: "test-model",
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "Hello" }
      ]
    })) {
      // Exhaust stream.
    }

    expect(requests[0]!.url).toBe("http://127.0.0.1:1234/api/v1/chat");
    const body = JSON.parse(requests[0]!.init.body as string);
    expect(body.model).toBe("test-model");
    expect(body.system_prompt).toBe("You are helpful.");
    expect(body.input).toContain("Hello");
    expect(body.stream).toBe(true);
    expect(body.store).toBe(false);
  });

  it("reports correct capabilities", async () => {
    const adapter = new LMStudioNativeAdapter();
    const caps = await adapter.getCapabilities();

    expect(caps.nativeTools).toBe(false);
    expect(caps.parallelTools).toBe(false);
    expect(caps.streamingToolCalls).toBe(false);
    expect(caps.structuredOutput).toBe(true);
  });
});

async function collect(adapter: LMStudioNativeAdapter): Promise<void> {
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
