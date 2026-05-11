import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface AgentDoc {
  path: string;
  title: string;
  content: string;
}

export async function readAgentDocs(root: string): Promise<AgentDoc[]> {
  const dir = join(root, ".buildr", "agent-docs");
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const docs: AgentDoc[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md")) {
      continue;
    }
    const path = join(dir, entry);
    const content = await readFile(path, "utf8");
    docs.push({
      path,
      title: firstHeading(content) ?? entry,
      content
    });
  }
  return docs;
}

function firstHeading(content: string): string | undefined {
  return content.split(/\r?\n/u).find((line) => line.startsWith("# "))?.replace(/^#\s+/u, "");
}
