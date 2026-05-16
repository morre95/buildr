import { DefaultPermissionPolicy, type PermissionPolicy } from "../permissions/policy.js";
import { createDefaultPlan, normalizePlan, validatePlan, type BuildrPlan } from "../plans/schema.js";
import { AnthropicAdapter } from "../providers/anthropic.js";
import { LMStudioNativeAdapter } from "../providers/lmStudioNative.js";
import { LMStudioOpenAIAdapter, OpenAIAdapter, OpenAICompatibleAdapter, OpenRouterAdapter } from "../providers/lmStudioOpenAI.js";
import { OllamaAdapter } from "../providers/ollama.js";
import type { ChatMessage, ModelAdapter, ProviderId } from "../types.js";
import { providerContextWarnings, providerErrorMessage } from "../providers/errors.js";
import { TokenBudgetExceededError, type TokenBudgetTracker, type TokenModelCall } from "./tokenBudget.js";

export interface BuildrCoreOptions {
  model?: ModelAdapter;
  permissions?: PermissionPolicy;
}

export interface ProviderConfig {
  provider: ProviderId;
  baseUrl?: string;
  apiKey?: string;
  getApiKey?: () => Promise<string | undefined>;
}

export interface ModelPlanResult {
  plan: BuildrPlan;
  source: "model" | "fallback";
  rawResponse?: string;
  warnings: string[];
  tokenCall?: TokenModelCall;
}

export interface ModelFileRewriteResult {
  updatedContent: string;
  summary: string;
  rawResponse: string;
  warnings: string[];
  tokenCall?: TokenModelCall;
}

export class BuildrCore {
  readonly model: ModelAdapter;
  readonly permissions: PermissionPolicy;

  constructor(options: BuildrCoreOptions = {}) {
    this.model = options.model ?? new OllamaAdapter();
    this.permissions = options.permissions ?? new DefaultPermissionPolicy();
  }

  createPlan(goal: string): BuildrPlan {
    return createDefaultPlan(goal);
  }

  async createPlanFromModel(options: {
    goal: string;
    modelId: string;
    contextSummary?: string;
    signal?: AbortSignal;
    onDelta?: (content: string) => void;
    budget?: TokenBudgetTracker;
  }): Promise<ModelPlanResult> {
    const fallback = this.createPlan(options.goal);
    let rawResponse = "";
    let budgetInput: { inputTokens: number; approximate: boolean } | undefined;

    try {
      const messages = createPlanMessages(options.goal, options.contextSummary);
      budgetInput = await options.budget?.prepareModelCall({
        adapter: this.model,
        modelId: options.modelId,
        label: "main_agent.plan",
        messages
      });
      for await (const delta of this.model.chat({
        model: options.modelId,
        temperature: 0.1,
        messages
      }, options.signal === undefined ? {} : { signal: options.signal })) {
        if (delta.type === "text" && delta.content !== undefined) {
          rawResponse += delta.content;
          options.onDelta?.(delta.content);
        }
      }

      const tokenCall = budgetInput === undefined ? undefined : await options.budget?.completeModelCall({
        adapter: this.model,
        modelId: options.modelId,
        label: "main_agent.plan",
        response: rawResponse,
        inputTokens: budgetInput.inputTokens,
        inputApproximate: budgetInput.approximate
      });
      const parsed = parsePlanResponse(rawResponse);
      const plan = validatePlan(normalizePlan(parsed, options.goal));
      return {
        plan,
        source: "model",
        rawResponse,
        warnings: [],
        ...(tokenCall === undefined ? {} : { tokenCall })
      };
    } catch (error) {
      if (error instanceof TokenBudgetExceededError) {
        throw error;
      }
      return {
        plan: fallback,
        source: "fallback",
        ...(rawResponse.length === 0 ? {} : { rawResponse }),
        warnings: [
          `Model plan generation failed; using fallback plan. ${providerErrorMessage(error)}`,
          ...providerContextWarnings(error).filter((warning) => warning !== providerErrorMessage(error))
        ]
      };
    }
  }

  async createFileRewriteFromModel(options: {
    goal: string;
    modelId: string;
    path: string;
    currentContent: string;
    contextSummary?: string;
    signal?: AbortSignal;
    budget?: TokenBudgetTracker;
    budgetLabel?: string;
  }): Promise<ModelFileRewriteResult> {
    let rawResponse = "";
    const messages = createFileRewriteMessages(options);
    const label = options.budgetLabel ?? "main_agent.rewrite";
    const budgetInput = await options.budget?.prepareModelCall({
      adapter: this.model,
      modelId: options.modelId,
      label,
      messages
    });
    for await (const delta of this.model.chat({
      model: options.modelId,
      temperature: 0.1,
      messages
    }, options.signal === undefined ? {} : { signal: options.signal })) {
      if (delta.type === "text" && delta.content !== undefined) {
        rawResponse += delta.content;
      }
    }

    const tokenCall = budgetInput === undefined ? undefined : await options.budget?.completeModelCall({
      adapter: this.model,
      modelId: options.modelId,
      label,
      response: rawResponse,
      inputTokens: budgetInput.inputTokens,
      inputApproximate: budgetInput.approximate
    });
    const parsed = parseFileRewriteResponse(rawResponse);
    return {
      updatedContent: parsed.updatedContent,
      summary: parsed.summary,
      rawResponse,
      warnings: parsed.updatedContent === options.currentContent ? ["Model returned content identical to the current file."] : [],
      ...(tokenCall === undefined ? {} : { tokenCall })
    };
  }

  static createModelAdapter(config: ProviderConfig): ModelAdapter {
    switch (config.provider) {
      case "ollama":
        return new OllamaAdapter(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl });
      case "lmstudio-openai":
        return new LMStudioOpenAIAdapter(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl });
      case "openai-compatible":
        return new OpenAICompatibleAdapter({
          ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
          ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
          ...(config.getApiKey === undefined ? {} : { getApiKey: config.getApiKey }),
          provider: "openai-compatible"
        });
      case "lmstudio-native":
        return new LMStudioNativeAdapter(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl });
      case "openai":
        return new OpenAIAdapter({
          ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
          ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
          ...(config.getApiKey === undefined ? {} : { getApiKey: config.getApiKey })
        });
      case "openrouter":
        return new OpenRouterAdapter({
          ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
          ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
          ...(config.getApiKey === undefined ? {} : { getApiKey: config.getApiKey })
        });
      case "anthropic":
        return new AnthropicAdapter({
          ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
          ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
          ...(config.getApiKey === undefined ? {} : { getApiKey: config.getApiKey })
        });
    }
  }
}

function createPlanMessages(goal: string, contextSummary: string | undefined): ChatMessage[] {
  const context = contextSummary === undefined || contextSummary.trim().length === 0
    ? "No workspace context summary is available yet."
    : contextSummary;
  return [
    {
      role: "system",
      content: [
        "You are Buildr Plan Mode.",
        "Return only JSON. Do not wrap the JSON in Markdown.",
        "Create a conservative implementation plan for a VS Code coding agent.",
        "The JSON must match this shape: { goal, acceptanceCriteria, scopeBoundaries, rulePacks, verification, steps }.",
        "verification must contain required, levels, commands, allowUnverifiedCompletion, includeOutputEvidence.",
        "Each step must contain id, title, kind, tools, targets, dependsOn, risk.",
        "Allowed step kind values: read, write, verify. Allowed risk values: low, medium, high.",
        "Keep write targets scoped and include a verify step when code changes are needed."
      ].join("\n")
    },
    {
      role: "user",
      content: [
        `Task: ${goal}`,
        "",
        "Workspace context summary:",
        context,
        "",
        "Produce a BuildrPlan JSON object now."
      ].join("\n")
    }
  ];
}

function parsePlanResponse(rawResponse: string): unknown {
  const trimmed = rawResponse.trim();
  if (trimmed.length === 0) {
    throw new Error("Model returned an empty plan response.");
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    const extracted = extractFirstJsonObject(trimmed);
    if (extracted === undefined) {
      throw new Error("Model response did not contain a JSON object.");
    }
    return JSON.parse(extracted);
  }
}

function createFileRewriteMessages(options: {
  goal: string;
  path: string;
  currentContent: string;
  contextSummary?: string;
}): ChatMessage[] {
  const context = options.contextSummary === undefined || options.contextSummary.trim().length === 0
    ? "No additional workspace context summary is available."
    : options.contextSummary;
  return [
    {
      role: "system",
      content: [
        "You are Buildr Agent Mode.",
        "Return only JSON. Do not wrap the JSON in Markdown.",
        "Rewrite exactly one text file to satisfy the task.",
        "Preserve unrelated code, imports, formatting style, line endings, and public APIs unless the task requires changing them.",
        "The JSON shape must be { \"summary\": string, \"updatedContent\": string }.",
        "updatedContent must contain the complete new file contents, not a diff."
      ].join("\n")
    },
    {
      role: "user",
      content: [
        `Task: ${options.goal}`,
        `File: ${options.path}`,
        options.currentContent.trim().length === 0
          ? "The target file is empty or does not exist yet. Create the complete file contents if the task requires this file."
          : "The target file exists. Rewrite the complete file contents.",
        "",
        "Relevant workspace context:",
        context,
        "",
        "Current file content:",
        "```",
        options.currentContent,
        "```"
      ].join("\n")
    }
  ];
}

function parseFileRewriteResponse(rawResponse: string): { summary: string; updatedContent: string } {
  const parsed = parsePlanResponse(rawResponse);
  if (!isRecord(parsed)) {
    throw new Error("File rewrite response must be a JSON object.");
  }
  if (typeof parsed.updatedContent !== "string") {
    throw new Error("File rewrite response must include updatedContent.");
  }
  return {
    summary: typeof parsed.summary === "string" && parsed.summary.trim().length > 0 ? parsed.summary.trim() : "Model proposed a file rewrite.",
    updatedContent: parsed.updatedContent
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractFirstJsonObject(value: string): string | undefined {
  const start = value.indexOf("{");
  if (start < 0) {
    return undefined;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const char = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return value.slice(start, index + 1);
      }
    }
  }

  return undefined;
}
