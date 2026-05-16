import { describe, expect, it } from "vitest";
import {
  applyAgentFileDiff,
  createTextPatchFromAgentDiff,
  formatTextPatchAsGitDiff,
  hashText,
  parseAgentEnvelope,
  validateCoderOutput,
  validateReviewerOutput,
  type AgentFileDiff
} from "../src/index.js";

describe("deterministic agent contracts", () => {
  it("parses and validates a reviewer JSON envelope", () => {
    const parsed = parseAgentEnvelope(
      JSON.stringify({
        role: "reviewer",
        version: 1,
        requestId: "reviewer:1",
        status: "ok",
        data: { status: "changes_needed", issues: ["Add a test."] },
        warnings: []
      }),
      "reviewer",
      "reviewer:1",
      validateReviewerOutput
    );

    expect(parsed.data).toEqual({ status: "changes_needed", issues: ["Add a test."] });
  });

  it("rejects envelopes with the wrong request id", () => {
    expect(() => parseAgentEnvelope(
      JSON.stringify({
        role: "reviewer",
        version: 1,
        requestId: "wrong",
        status: "ok",
        data: { status: "approved" },
        warnings: []
      }),
      "reviewer",
      "reviewer:1",
      validateReviewerOutput
    )).toThrow("requestId");
  });

  it("validates coder structured diffs", () => {
    const current = "one\ntwo\nthree\n";
    const diff: AgentFileDiff = {
      path: "src/example.ts",
      beforeHash: hashText(current),
      hunks: [{
        oldStart: 2,
        oldLines: 1,
        newStart: 2,
        newLines: 1,
        lines: ["-two", "+deux"]
      }]
    };

    const output = validateCoderOutput({ summary: "Updated text.", diffs: [diff] });

    expect(output.diffs[0]).toEqual(diff);
    expect(applyAgentFileDiff(current, diff)).toBe("one\ndeux\nthree\n");
  });

  it("detects hunk conflicts", () => {
    const current = "one\ntwo\n";
    const diff: AgentFileDiff = {
      path: "src/example.ts",
      beforeHash: hashText(current),
      hunks: [{
        oldStart: 2,
        oldLines: 1,
        newStart: 2,
        newLines: 1,
        lines: ["-missing", "+deux"]
      }]
    };

    expect(() => applyAgentFileDiff(current, diff)).toThrow("removal mismatch");
  });

  it("formats validated patches as git-style diffs", () => {
    const current = "one\ntwo\n";
    const diff: AgentFileDiff = {
      path: "src/example.ts",
      beforeHash: hashText(current),
      hunks: [{
        oldStart: 2,
        oldLines: 1,
        newStart: 2,
        newLines: 1,
        lines: ["-two", "+deux"]
      }]
    };
    const patch = createTextPatchFromAgentDiff(current, diff, "src/example.ts");
    const formatted = formatTextPatchAsGitDiff(patch);

    expect(formatted).toContain("diff --git a/src/example.ts b/src/example.ts");
    expect(formatted).toContain("-two");
    expect(formatted).toContain("+deux");
  });
});
