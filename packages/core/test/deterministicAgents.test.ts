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

  it("repairs model JSON that uses string concatenation for a hunk line", () => {
    const parsed = parseAgentEnvelope(
      [
        "{\"role\":\"coder\",\"version\":1,\"requestId\":\"coder:1\",\"status\":\"ok\",",
        "\"data\":{\"summary\":\"Added file.\",\"diffs\":[{\"path\":\"script.js\",",
        "\"beforeHash\":\"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\",",
        "\"hunks\":[{\"oldStart\":0,\"oldLines\":0,\"newStart\":1,\"newLines\":2,",
        "\"lines\":[\"+(() => {\",\"+\" + \"})();\"]}]}]},\"warnings\":[]}"
      ].join(""),
      "coder",
      "coder:1",
      validateCoderOutput
    );

    expect(parsed.data.diffs[0]?.hunks[0]?.lines).toEqual(["+(() => {", "+})();"]);
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

  it("normalizes raw new-file hunk lines into additions", () => {
    const current = "";
    const diff: AgentFileDiff = {
      path: "index.html",
      beforeHash: hashText(current),
      hunks: [{
        oldStart: 0,
        oldLines: 0,
        newStart: 1,
        newLines: 2,
        lines: ["<!doctype html>", "<canvas></canvas>"]
      }]
    };

    expect(applyAgentFileDiff(current, diff)).toBe("<!doctype html>\n<canvas></canvas>\n");
  });

  it("normalizes raw new-file hunk lines when oldStart is one", () => {
    const current = "";
    const diff: AgentFileDiff = {
      path: "index.html",
      beforeHash: hashText(current),
      hunks: [{
        oldStart: 1,
        oldLines: 0,
        newStart: 1,
        newLines: 2,
        lines: ["<!doctype html>", "<canvas></canvas>"]
      }]
    };

    expect(applyAgentFileDiff(current, diff)).toBe("<!doctype html>\n<canvas></canvas>\n");
  });

  it("normalizes indented raw new-file lines as additions", () => {
    const current = "";
    const diff: AgentFileDiff = {
      path: "index.html",
      beforeHash: hashText(current),
      hunks: [{
        oldStart: 1,
        oldLines: 2,
        newStart: 1,
        newLines: 2,
        lines: ["<script>", "  const speed = 120;", "</script>"]
      }]
    };

    expect(applyAgentFileDiff(current, diff)).toBe("<script>\n  const speed = 120;\n</script>\n");
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
