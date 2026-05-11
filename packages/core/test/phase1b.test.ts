import { describe, expect, it } from "vitest";
import { ContextFirewall } from "../src/security/contextFirewall.js";
import { getWorkspaceTrustState } from "../src/security/workspaceTrust.js";
import { checkScopeFidelity } from "../src/rules/scopeFidelity.js";
import { loadBuiltInRulePacks } from "../src/rules/ruleEngine.js";
import { runCompletionGate } from "../src/verification/completionGate.js";
import { LMStudioNativeAdapter } from "../src/providers/lmStudioNative.js";

describe("Phase 1B hardening", () => {
  it("blocks sensitive paths and redacts likely secrets", () => {
    const firewall = new ContextFirewall();

    expect(firewall.inspectPath("/repo/.env").allowed).toBe(false);

    const decision = firewall.inspectText('api_key = "supersecretvalue"');
    expect(decision.redactedText).toBe("[REDACTED_SECRET]");
    expect(decision.warnings).toHaveLength(1);
  });

  it("reports untrusted workspace capabilities", () => {
    const state = getWorkspaceTrustState(false);

    expect(state.mode).toBe("read_only_plan");
    expect(state.disabledCapabilities).toContain("file_writes");
  });

  it("flags changed files outside approved targets", () => {
    const result = checkScopeFidelity({
      workspaceRoot: "/repo",
      approvedTargets: ["src/**"],
      changedFiles: ["/repo/src/index.ts", "/repo/README.md"]
    });

    expect(result.ok).toBe(false);
    expect(result.outOfScopeFiles).toEqual(["/repo/README.md"]);
  });

  it("blocks completion when verification evidence is missing", () => {
    const gate = runCompletionGate({
      events: [],
      rulePacks: loadBuiltInRulePacks(["verification"])
    });

    expect(gate.status).toBe("blocked");
  });

  it("keeps LM Studio native adapter as an explicit skeleton", async () => {
    const adapter = new LMStudioNativeAdapter();
    const iterator = adapter.chat({ model: "local", messages: [] });

    await expect(iterator.next()).rejects.toThrow("Phase 1B skeleton");
  });
});
