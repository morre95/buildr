import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { buildWorkspaceIndex } from "../src/context/workspaceIndex.js";
import { rankWorkspaceContext } from "../src/context/ranking.js";
import { compressRankedContext } from "../src/context/compression.js";
import { buildContextGraph } from "../src/context/graph.js";
import { readAgentDocs } from "../src/memory/agentDocs.js";
import { matchCommonMistakes, readCommonMistakes } from "../src/memory/commonMistakes.js";
import { DisabledDocsProvider } from "../src/docs/context7Provider.js";
import { runDualVerificationPass } from "../src/verification/dualPass.js";

describe("Phase 2 context and memory", () => {
  it("indexes, ranks, compresses, and graphs workspace files", async () => {
    const root = await mkdtemp(join(tmpdir(), "buildr-phase2-"));
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "auth.ts"), "export function validateToken() { return true; }\n");
    await writeFile(join(root, "src", "auth.test.ts"), "import { validateToken } from './auth';\n");

    const index = await buildWorkspaceIndex(root);
    const ranked = rankWorkspaceContext(index, "validate token auth");
    const compressed = compressRankedContext(ranked);
    const graph = buildContextGraph(index);

    expect(index.files.map((file) => file.relativePath)).toContain("src/auth.ts");
    expect(ranked[0]?.file.relativePath).toBe("src/auth.ts");
    expect(compressed.includedFiles.length).toBeGreaterThan(0);
    expect(graph.nodes).toContain("src/auth.ts");
  });

  it("reads agent docs and matches common mistakes", async () => {
    const root = await mkdtemp(join(tmpdir(), "buildr-memory-"));
    await mkdir(join(root, ".buildr", "agent-docs"), { recursive: true });
    await writeFile(join(root, ".buildr", "agent-docs", "project-summary.md"), "# Project Summary\nBuildr notes\n");
    await writeFile(
      join(root, ".buildr", "common-mistakes.jsonl"),
      '{"id":"m1","pattern":"Changed unrelated files","avoidanceRule":"Check scope","severity":"medium","createdAt":"2026-05-11"}\n'
    );

    const docs = await readAgentDocs(root);
    const mistakes = await readCommonMistakes(root);

    expect(docs[0]?.title).toBe("Project Summary");
    expect(matchCommonMistakes(mistakes, "avoid changed files")).toHaveLength(1);
  });

  it("returns disabled docs provider fallback", async () => {
    const provider = new DisabledDocsProvider();

    await expect(provider.resolveLibrary("vscode")).resolves.toEqual([]);
    await expect(provider.queryDocs("/microsoft/vscode-docs", "chat")).resolves.toMatchObject({
      libraryId: "/microsoft/vscode-docs"
    });
  });

  it("runs confirmation and adversarial verification passes", () => {
    const passes = runDualVerificationPass([
      {
        id: "diagnostics",
        title: "Read diagnostics",
        status: "completed",
        summary: "No diagnostics",
        evidence: { diagnosticsSummary: "No diagnostics" },
        warnings: []
      }
    ]);

    expect(passes).toHaveLength(2);
    expect(passes[1]?.ok).toBe(true);
  });
});
