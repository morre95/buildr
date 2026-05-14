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
