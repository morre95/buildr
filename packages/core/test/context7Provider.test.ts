import { describe, expect, it } from "vitest";
import { Context7DocsProvider, DisabledDocsProvider, createDocsProvider } from "../src/index.js";

describe("Context7DocsProvider", () => {
  it("resolves libraries via the Context7 API", async () => {
    const provider = new Context7DocsProvider({
      fetchImpl: async (_url, init) => {
        const body = JSON.parse((init as RequestInit).body as string);
        expect(body.query).toBe("react hooks");
        return new Response(JSON.stringify({
          results: [
            { id: "/facebook/react", name: "React", description: "UI library" },
            { id: "/preactjs/preact", name: "Preact", description: "Fast alternative" }
          ]
        }), { status: 200 });
      }
    });

    const results = await provider.resolveLibrary("react hooks");

    expect(results).toEqual([
      { id: "/facebook/react", name: "React", description: "UI library" },
      { id: "/preactjs/preact", name: "Preact", description: "Fast alternative" }
    ]);
  });

  it("returns empty array when resolve fails", async () => {
    const provider = new Context7DocsProvider({
      fetchImpl: async () => new Response("", { status: 500 })
    });

    const results = await provider.resolveLibrary("nonexistent");

    expect(results).toEqual([]);
  });

  it("queries docs for a library", async () => {
    const provider = new Context7DocsProvider({
      fetchImpl: async (_url, init) => {
        const body = JSON.parse((init as RequestInit).body as string);
        expect(body.libraryId).toBe("/facebook/react");
        expect(body.query).toBe("useEffect cleanup");
        return new Response(JSON.stringify({
          libraryId: "/facebook/react",
          content: "useEffect accepts a cleanup function...",
          sources: ["https://react.dev/reference/react/useEffect"]
        }), { status: 200 });
      }
    });

    const result = await provider.queryDocs("/facebook/react", "useEffect cleanup");

    expect(result.content).toContain("useEffect accepts a cleanup function");
    expect(result.provenance).toEqual(["https://react.dev/reference/react/useEffect"]);
    expect(result.topic).toBe("useEffect cleanup");
  });

  it("returns error content when query fails", async () => {
    const provider = new Context7DocsProvider({
      fetchImpl: async () => new Response("", { status: 503 })
    });

    const result = await provider.queryDocs("/some/lib", "topic");

    expect(result.content).toContain("503");
    expect(result.provenance).toEqual([]);
  });

  it("uses custom base URL", async () => {
    const urls: string[] = [];
    const provider = new Context7DocsProvider({
      baseUrl: "https://custom.context7.test/api",
      fetchImpl: async (url) => {
        urls.push(url as string);
        return new Response(JSON.stringify({ results: [] }), { status: 200 });
      }
    });

    await provider.resolveLibrary("test");

    expect(urls[0]).toBe("https://custom.context7.test/api/v1/resolve");
  });
});

describe("DisabledDocsProvider", () => {
  it("returns empty results and fallback content", async () => {
    const provider = new DisabledDocsProvider();

    expect(await provider.resolveLibrary("anything")).toEqual([]);
    const result = await provider.queryDocs("/some/lib", "topic");
    expect(result.content).toContain("not configured");
  });
});

describe("createDocsProvider", () => {
  it("returns Context7DocsProvider when enabled", () => {
    const provider = createDocsProvider({ enabled: true });
    expect(provider).toBeInstanceOf(Context7DocsProvider);
  });

  it("returns DisabledDocsProvider when disabled", () => {
    const provider = createDocsProvider({ enabled: false });
    expect(provider).toBeInstanceOf(DisabledDocsProvider);
  });

  it("returns Context7DocsProvider by default", () => {
    const provider = createDocsProvider();
    expect(provider).toBeInstanceOf(Context7DocsProvider);
  });
});
