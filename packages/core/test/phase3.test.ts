import { describe, expect, it } from "vitest";
import { createDebugSession, observationsFromLog } from "../src/debug/debugMode.js";
import { parseMcpConfig } from "../src/mcp/config.js";
import { parseMcpPolicyOverlay } from "../src/mcp/policy.js";
import { createMcpRegistrySnapshot } from "../src/mcp/registry.js";
import { markMcpServerError, nextBackoffMs } from "../src/mcp/status.js";
import { runMcpDoctor } from "../src/mcp/doctor.js";

describe("Phase 3 MCP and Debug Mode", () => {
  it("parses MCP config and maps tools through policy", () => {
    const config = parseMcpConfig(JSON.stringify({
      servers: {
        filesystem: {
          type: "stdio",
          command: "node",
          args: ["server.js"],
          env: { TOKEN: "${env:TOKEN}" }
        }
      }
    }));
    const policy = parseMcpPolicyOverlay(JSON.stringify({
      servers: {
        filesystem: {
          writeToolsRequireApproval: true
        }
      }
    }));
    const snapshot = createMcpRegistrySnapshot(config, policy, [
      { serverName: "filesystem", name: "write_file", description: "Write file" }
    ]);

    expect(config.servers[0]?.name).toBe("filesystem");
    expect(snapshot.tools[0]?.permission).toBe("require_approval");
    expect(snapshot.warnings[0]).toContain("environment variables");
  });

  it("reports MCP doctor warnings and backoff", () => {
    const config = parseMcpConfig(JSON.stringify({ servers: { legacy: { type: "sse", url: "http://localhost/sse" } } }));
    const snapshot = createMcpRegistrySnapshot(config);
    const doctor = runMcpDoctor(snapshot);
    const errored = markMcpServerError(snapshot.servers[0]!, "connection closed");

    expect(doctor.ok).toBe(false);
    expect(nextBackoffMs(2)).toBe(4000);
    expect(errored.nextRetryMs).toBe(2000);
  });

  it("creates debug hypotheses from logs", () => {
    const session = createDebugSession({
      observations: observationsFromLog("Error: Cannot find module '@buildr/core'")
    });

    expect(session.hypotheses[0]?.id).toBe("missing-module");
  });

  it("recognizes short and package-manager debug logs", () => {
    const short = createDebugSession({
      observations: observationsFromLog("hello")
    });
    const packageManifest = createDebugSession({
      observations: observationsFromLog("ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND No package.json was found")
    });

    expect(short.hypotheses[0]?.id).toBe("log-too-short");
    expect(packageManifest.hypotheses[0]?.id).toBe("missing-package-manifest");
  });
});
