import { describe, expect, it } from "vitest";
import { loadBuiltInRulePacks, renderRulePackGuidance } from "../src/rules/ruleEngine.js";

describe("renderRulePackGuidance", () => {
  it("renders each pack's rules with severity labels", () => {
    const guidance = renderRulePackGuidance(loadBuiltInRulePacks(["git-workflow"]));

    expect(guidance).toContain("Follow these project rules while completing the task:");
    // warn/error rules become visible to the agent instead of sitting unused.
    expect(guidance).toContain("(required) Read relevant code and understand existing patterns before editing.");
    expect(guidance).toContain("(required) Apply file changes through approved diffs and preserve user changes.");
    expect(guidance).toContain("(required to complete) Do not claim completion without verification evidence");
  });

  it("returns an empty string when no packs contribute rules", () => {
    expect(renderRulePackGuidance([])).toBe("");
  });
});
