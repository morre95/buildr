#!/usr/bin/env node
// #region agent log
/**
 * Mirrors vsce dependency validation: npm list --production --parseable --depth=99999
 */
// #endregion
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const extRoot = join(__dirname, "..");
const INGEST =
  "http://127.0.0.1:7459/ingest/8daf4a28-f829-45d4-be01-fade78b99b8c";
const SESSION = "f052d1";
const RUN = process.env.BUILDR_DEBUG_RUN ?? "hypothesis-run";

function agentLog(hypothesisId, message, data) {
  const payload = {
    sessionId: SESSION,
    runId: RUN,
    hypothesisId,
    location: "packages/extension/scripts/debug-vsce-hypotheses.mjs",
    message,
    data,
    timestamp: Date.now()
  };
  const logDir = join(extRoot, "..", "..", ".cursor");
  const logPath = join(logDir, "debug-f052d1.log");
  // #region agent log
  try {
    mkdirSync(logDir, { recursive: true });
    appendFileSync(logPath, `${JSON.stringify(payload)}\n`);
  } catch {
    // ignore
  }
  fetch(INGEST, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Debug-Session-Id": SESSION
    },
    body: JSON.stringify(payload)
  }).catch(() => {});
  // #endregion
}

const corePkgPath = join(extRoot, "..", "core", "package.json");
let coreDeps = {};
try {
  coreDeps = JSON.parse(readFileSync(corePkgPath, "utf8")).dependencies ?? {};
} catch {
  coreDeps = { _error: "read_failed" };
}

const coreNm = join(extRoot, "node_modules", "@buildr", "core");
let coreResolution = "missing";
try {
  if (existsSync(coreNm)) {
    coreResolution = realpathSync(coreNm);
  }
} catch (e) {
  coreResolution = String(e instanceof Error ? e.message : e);
}

agentLog("H1", "extension host + @buildr/core resolution", {
  extRoot,
  coreResolution,
  hasCorePackageJson: existsSync(join(coreNm, "package.json"))
});

agentLog(
  "H2",
  "@buildr/core production dependencies keys",
  { keys: Object.keys(coreDeps), hasTransformers: "@huggingface/transformers" in coreDeps }
);

let npmExit = 0;
let npmStderr = "";
let npmStdout = "";
try {
  npmStdout = execFileSync(
    "npm",
    ["list", "--production", "--parseable", "--depth=99999", "--loglevel=error"],
    { cwd: extRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );
} catch (error) {
  npmExit =
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof (/** @type {{ status?: number }} */ (error).status) === "number"
      ? /** @type {{ status: number }} */ (error).status
      : 1;
  npmStderr =
    "stderr" in error && typeof (/** @type {{ stderr?: string }} */ (error).stderr) === "string"
      ? String((/** @type {{ stderr?: string }} */ (error).stderr))
      : "";
  const out =
    "stdout" in error && typeof (/** @type {{ stdout?: string }} */ (error).stdout) === "string"
      ? String((/** @type {{ stdout?: string }} */ (error).stdout))
      : "";
  if (!npmStderr && out) {
    npmStderr = out;
  }
}

const snippet = [npmStdout, npmStderr].join("\n").slice(0, 12000);

agentLog("H3", "npm list --production mirror exit", {
  npmExit,
  stderrHead: npmStderr.slice(0, 2000),
  stdoutLines: npmStdout.split("\n").length
});

agentLog("H4", "npm list mentions huggingface / transformers tree", {
  mentionsHuggingface: /@huggingface\/transformers\b/i.test(snippet),
  mentionsOnnx: /\bonnxruntime\b/i.test(snippet)
});

agentLog("H5", "npm list mentions invalid @buildr/core / workspace", {
  mentionsInvalidCore: /\binvalid:.*@buildr\/core\b/i.test(snippet),
  mentionsELSPROBLEMS: /\bELSPROBLEMS\b/i.test(snippet)
});

console.log(JSON.stringify({ npmExit, summary: snippet.slice(0, 500) }));
