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
    // .vscode holds editor/Buildr settings, not project context for the LLM.
    expect(firewall.inspectPath("/repo/.vscode/settings.json").allowed).toBe(false);
    expect(firewall.inspectPath("/repo/src/app.ts").allowed).toBe(true);

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

  it("allows completion when verification is explicitly skipped with a rationale", () => {
    const gate = runCompletionGate({
      events: [],
      rulePacks: loadBuiltInRulePacks(["verification"]),
      skippedVerificationReason: "CLI read-only session"
    });

    expect(gate.status).toBe("complete");
    expect(gate.summary).toContain("CLI read-only session");
    expect(gate.summary).not.toContain("passed with verification evidence");
  });

  it("creates a working LM Studio native adapter", async () => {
    const adapter = new LMStudioNativeAdapter();
    const capabilities = await adapter.getCapabilities();

    expect(capabilities.nativeTools).toBe(false);
    expect(capabilities.structuredOutput).toBe(true);
    expect(adapter.provider).toBe("lmstudio-native");
  });
});
