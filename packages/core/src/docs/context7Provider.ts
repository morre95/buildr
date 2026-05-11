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
