import { resolve } from "node:path";
import type { TextPatch } from "../diff/textPatch.js";
import { ToolRegistry, type ToolHandler } from "../runtime/toolLoop.js";
import type { ToolCall } from "../types.js";
import {
  applyPatchTool,
  builtInTools,
  proposePatchTool,
  readFileTool,
  searchCodebaseTool
} from "./builtins.js";

export interface CreateBuiltInToolRegistryOptions {
  /** When set, file/search arguments are resolved relative to this root before execution. */
  workspaceRoot?: string;
  /** Executes `run_terminal`. Required to expose terminal access; omitted handlers stay unavailable. */
  runTerminal?: ToolHandler;
  /** Executes `read_diagnostics`. */
  readDiagnostics?: ToolHandler;
}

/**
 * Builds a registry of the built-in tools backed by their core implementations.
 * `run_terminal` and `read_diagnostics` have no host-independent implementation,
 * so they are only registered when a handler is injected (e.g. by the extension
 * for VS Code tasks/diagnostics). Tools whose handler is absent are simply not
 * offered to the model.
 */
export function createBuiltInToolRegistry(options: CreateBuiltInToolRegistryOptions = {}): ToolRegistry {
  const root = options.workspaceRoot;
  const handlers: Record<string, ToolHandler | undefined> = {
    read_file: async (call) => readFileTool(resolveArg(root, requireStringArg(call, "path"))),
    search_codebase: async (call) =>
      searchCodebaseTool(resolveArg(root, optionalStringArg(call, "root") ?? "."), requireStringArg(call, "query")),
    propose_patch: async (call) => proposePatchTool(resolveArg(root, requireStringArg(call, "path")), requireStringArg(call, "nextContent")),
    apply_patch: async (call) => applyPatchTool(requirePatchArg(call)),
    run_terminal: options.runTerminal,
    read_diagnostics: options.readDiagnostics
  };

  const registry = new ToolRegistry();
  for (const definition of builtInTools) {
    const handler = handlers[definition.name];
    if (handler !== undefined) {
      registry.register({ definition, handler });
    }
  }
  return registry;
}

function resolveArg(root: string | undefined, value: string): string {
  return root === undefined ? value : resolve(root, value);
}

function requireStringArg(call: ToolCall, key: string): string {
  const value = optionalStringArg(call, key);
  if (value === undefined) {
    throw new Error(`Tool "${call.name}" requires a non-empty string argument "${key}".`);
  }
  return value;
}

function optionalStringArg(call: ToolCall, key: string): string | undefined {
  const value = call.arguments[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function requirePatchArg(call: ToolCall): TextPatch {
  const candidate = call.arguments.patch ?? call.arguments;
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    typeof (candidate as { path?: unknown }).path !== "string"
  ) {
    throw new Error(`Tool "${call.name}" requires a "patch" object with at least a "path" string.`);
  }
  return candidate as TextPatch;
}
