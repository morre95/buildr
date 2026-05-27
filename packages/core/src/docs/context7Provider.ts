export interface ResolvedLibrary {
  id: string;
  name: string;
  description?: string;
}

export interface DocsResult {
  libraryId: string;
  topic: string;
  content: string;
  provenance: string[];
}

export interface DocsProvider {
  resolveLibrary(query: string): Promise<ResolvedLibrary[]>;
  queryDocs(libraryId: string, topic: string): Promise<DocsResult>;
}

export interface Context7DocsProviderOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

interface Context7ResolveResponse {
  results?: Array<{
    id?: string;
    name?: string;
    description?: string;
  }>;
}

interface Context7QueryResponse {
  libraryId?: string;
  content?: string;
  sources?: string[];
}

export class Context7DocsProvider implements DocsProvider {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: Context7DocsProviderOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "https://context7.com/api").replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async resolveLibrary(query: string): Promise<ResolvedLibrary[]> {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query })
    });
    if (!response.ok) {
      return [];
    }
    const data = (await response.json()) as Context7ResolveResponse;
    return (data.results ?? [])
      .filter((result): result is { id: string; name: string; description?: string } =>
        typeof result.id === "string" && typeof result.name === "string"
      )
      .map((result) => ({
        id: result.id,
        name: result.name,
        ...(result.description === undefined ? {} : { description: result.description })
      }));
  }

  async queryDocs(libraryId: string, topic: string): Promise<DocsResult> {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ libraryId, query: topic })
    });
    if (!response.ok) {
      return {
        libraryId,
        topic,
        content: `Context7 query failed with HTTP ${response.status}.`,
        provenance: []
      };
    }
    const data = (await response.json()) as Context7QueryResponse;
    return {
      libraryId: data.libraryId ?? libraryId,
      topic,
      content: data.content ?? "",
      provenance: data.sources ?? []
    };
  }
}

export class DisabledDocsProvider implements DocsProvider {
  async resolveLibrary(): Promise<ResolvedLibrary[]> {
    return [];
  }

  async queryDocs(libraryId: string, topic: string): Promise<DocsResult> {
    return {
      libraryId,
      topic,
      content: "Context7 docs provider is not configured in this runtime.",
      provenance: []
    };
  }
}

export function createDocsProvider(options?: Context7DocsProviderOptions & { enabled?: boolean }): DocsProvider {
  if (options?.enabled === false) {
    return new DisabledDocsProvider();
  }
  return new Context7DocsProvider(options);
}
