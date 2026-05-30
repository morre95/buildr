import { DefaultPermissionPolicy, type PermissionPolicy } from "../permissions/policy.js";
import type {
  ChatMessage,
  ModelAdapter,
  PermissionDecision,
  ToolCall,
  ToolDefinition,
  ToolResult
} from "../types.js";
import { runBoundedParallel } from "./concurrency.js";
import {
  TokenBudgetExceededError,
  type TokenBudgetState,
  type TokenBudgetTracker,
  type TokenModelCall
} from "./tokenBudget.js";

/** Executes a single tool call and resolves to its result. */
export type ToolHandler = (call: ToolCall, options: { signal?: AbortSignal }) => Promise<ToolResult>;

export interface ToolRegistryEntry {
  definition: ToolDefinition;
  handler: ToolHandler;
}

/**
 * Name-indexed set of executable tools. The loop reads `definitions()` to tell
 * the model what it can call and `get()` to dispatch a call the model made.
 */
export class ToolRegistry {
  private readonly entries = new Map<string, ToolRegistryEntry>();

  register(entry: ToolRegistryEntry): this {
    this.entries.set(entry.definition.name, entry);
    return this;
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  get(name: string): ToolRegistryEntry | undefined {
    return this.entries.get(name);
  }

  definitions(): ToolDefinition[] {
    return [...this.entries.values()].map((entry) => entry.definition);
  }
}

export interface ToolApprovalRequest {
  call: ToolCall;
  definition: ToolDefinition;
  risk: "low" | "medium" | "high";
}

export type ToolLoopEvent =
  | { type: "model_turn"; iteration: number; text: string; toolCalls: ToolCall[] }
  | { type: "tool_started"; call: ToolCall; ranInParallel: boolean }
  | { type: "tool_completed"; call: ToolCall; result: ToolResult; ranInParallel: boolean }
  | { type: "tool_skipped"; call: ToolCall; decision: PermissionDecision };

export interface ToolCallingSessionOptions {
  adapter: ModelAdapter;
  modelId: string;
  /** Seed conversation, typically a system prompt followed by the user task. */
  messages: ChatMessage[];
  registry: ToolRegistry;
  permissions?: PermissionPolicy;
  isTrusted?: boolean;
  temperature?: number;
  maxIterations?: number;
  maxParallelTools?: number;
  budget?: TokenBudgetTracker;
  signal?: AbortSignal;
  /** Called for tools whose permission resolves to "ask". Omit to deny them. */
  requestApproval?: (request: ToolApprovalRequest) => Promise<PermissionDecision>;
  onEvent?: (event: ToolLoopEvent) => void;
}

export interface ToolExecutionRecord {
  call: ToolCall;
  decision: PermissionDecision;
  ranInParallel: boolean;
  result: ToolResult;
}

export type ToolLoopStoppedReason = "completed" | "max_iterations" | "aborted" | "budget_exceeded";

export interface ToolCallingSessionReport {
  finalText: string;
  iterations: number;
  stoppedReason: ToolLoopStoppedReason;
  toolExecutions: ToolExecutionRecord[];
  messages: ChatMessage[];
  warnings: string[];
  tokenBudget?: TokenBudgetState;
}

const DEFAULT_MAX_ITERATIONS = 8;
const DEFAULT_MAX_PARALLEL_TOOLS = 4;

interface ModelTurn {
  text: string;
  toolCalls: ToolCall[];
  tokenCall?: TokenModelCall;
}

interface ToolPlan {
  call: ToolCall;
  entry: ToolRegistryEntry;
  decision: PermissionDecision;
}

/**
 * Drives a provider through an agentic tool-use loop: the model proposes tool
 * calls, the loop executes the allowed ones — read-only tools concurrently,
 * mutating/approval-gated tools serially — feeds the results back, and repeats
 * until the model answers without requesting more tools.
 */
export class ToolCallingSession {
  private readonly permissions: PermissionPolicy;
  private readonly isTrusted: boolean;
  private readonly maxIterations: number;
  private readonly maxParallelTools: number;
  private readonly messages: ChatMessage[];
  private readonly toolExecutions: ToolExecutionRecord[] = [];
  private readonly warnings: string[] = [];

  constructor(private readonly options: ToolCallingSessionOptions) {
    this.permissions = options.permissions ?? new DefaultPermissionPolicy();
    this.isTrusted = options.isTrusted ?? true;
    this.maxIterations = Math.max(1, Math.floor(options.maxIterations ?? DEFAULT_MAX_ITERATIONS));
    this.maxParallelTools = Math.max(1, Math.floor(options.maxParallelTools ?? DEFAULT_MAX_PARALLEL_TOOLS));
    this.messages = [...options.messages];
  }

  async run(): Promise<ToolCallingSessionReport> {
    let finalText = "";
    let iterations = 0;
    let stoppedReason: ToolLoopStoppedReason = "max_iterations";

    for (let iteration = 0; iteration < this.maxIterations; iteration += 1) {
      if (this.options.signal?.aborted === true) {
        stoppedReason = "aborted";
        break;
      }

      iterations = iteration + 1;
      let turn: ModelTurn;
      try {
        turn = await this.runModelTurn(`tool_loop.turn_${iteration + 1}`);
      } catch (error) {
        if (error instanceof TokenBudgetExceededError) {
          this.warnings.push(error.message);
          stoppedReason = "budget_exceeded";
          break;
        }
        throw error;
      }

      finalText = turn.text;
      this.messages.push(toAssistantMessage(turn));
      this.options.onEvent?.({ type: "model_turn", iteration: iteration + 1, text: turn.text, toolCalls: turn.toolCalls });

      if (turn.toolCalls.length === 0) {
        stoppedReason = "completed";
        break;
      }

      const results = await this.executeToolCalls(turn.toolCalls);
      for (const call of turn.toolCalls) {
        const result = results.get(call.id);
        if (result !== undefined) {
          this.messages.push(toToolMessage(call, result));
        }
      }
    }

    if (stoppedReason === "max_iterations") {
      this.warnings.push(`Tool-calling loop stopped after reaching the ${this.maxIterations}-iteration limit.`);
    }

    const tokenBudget = this.options.budget?.snapshot();
    return {
      finalText,
      iterations,
      stoppedReason,
      toolExecutions: this.toolExecutions,
      messages: this.messages,
      warnings: [...this.warnings, ...(tokenBudget?.warnings.map((warning) => warning.message) ?? [])],
      ...(tokenBudget === undefined ? {} : { tokenBudget })
    };
  }

  private async runModelTurn(label: string): Promise<ModelTurn> {
    const messages = [...this.messages];
    const budgetInput = await this.options.budget?.prepareModelCall({
      adapter: this.options.adapter,
      modelId: this.options.modelId,
      label,
      messages
    });

    let text = "";
    const toolCalls: ToolCall[] = [];
    for await (const delta of this.options.adapter.chat(
      {
        model: this.options.modelId,
        temperature: this.options.temperature ?? 0.1,
        messages,
        tools: this.options.registry.definitions()
      },
      this.options.signal === undefined ? {} : { signal: this.options.signal }
    )) {
      if (delta.type === "text" && delta.content !== undefined) {
        text += delta.content;
      } else if (delta.type === "tool_call" && delta.toolCall !== undefined) {
        toolCalls.push(delta.toolCall);
      }
    }

    const tokenCall = budgetInput === undefined
      ? undefined
      : await this.options.budget?.completeModelCall({
        adapter: this.options.adapter,
        modelId: this.options.modelId,
        label,
        response: text,
        inputTokens: budgetInput.inputTokens,
        inputApproximate: budgetInput.approximate
      });

    return { text, toolCalls, ...(tokenCall === undefined ? {} : { tokenCall }) };
  }

  private async executeToolCalls(calls: ToolCall[]): Promise<Map<string, ToolResult>> {
    const results = new Map<string, ToolResult>();
    const plans: ToolPlan[] = [];

    for (const call of calls) {
      const entry = this.options.registry.get(call.name);
      if (entry === undefined) {
        results.set(call.id, unknownToolResult(call));
        this.toolExecutions.push({ call, decision: "deny", ranInParallel: false, result: results.get(call.id)! });
        this.options.onEvent?.({ type: "tool_skipped", call, decision: "deny" });
        continue;
      }
      const decision = await this.resolveDecision(call, entry.definition);
      plans.push({ call, entry, decision });
    }

    const parallel = plans.filter((plan) => plan.decision === "allow" && plan.entry.definition.permission === "auto_allow");
    const sequential = plans.filter((plan) => plan.decision === "allow" && plan.entry.definition.permission !== "auto_allow");
    const skipped = plans.filter((plan) => plan.decision !== "allow");

    for (const plan of skipped) {
      const result = deniedToolResult(plan.call, plan.decision);
      results.set(plan.call.id, result);
      this.toolExecutions.push({ call: plan.call, decision: plan.decision, ranInParallel: false, result });
      this.options.onEvent?.({ type: "tool_skipped", call: plan.call, decision: plan.decision });
    }

    const parallelResults = await runBoundedParallel(parallel, this.maxParallelTools, (plan) => this.invoke(plan, true));
    parallel.forEach((plan, index) => {
      results.set(plan.call.id, parallelResults[index]!);
    });

    for (const plan of sequential) {
      results.set(plan.call.id, await this.invoke(plan, false));
    }

    return results;
  }

  private async resolveDecision(call: ToolCall, definition: ToolDefinition): Promise<PermissionDecision> {
    if (!this.isTrusted && definition.permission !== "auto_allow") {
      // Untrusted workspaces stay read-only: anything that could mutate or run
      // commands is blocked outright rather than prompting for approval.
      return "deny";
    }
    const command = stringArg(call, "command");
    const target = toolTarget(call);
    const decision = this.permissions.decide({
      tool: definition,
      ...(command === undefined ? {} : { command }),
      ...(target === undefined ? {} : { target })
    });
    if (decision !== "ask") {
      return decision;
    }
    if (this.options.requestApproval === undefined) {
      return "deny";
    }
    return this.options.requestApproval({ call, definition, risk: riskForPermission(definition) });
  }

  private async invoke(plan: ToolPlan, ranInParallel: boolean): Promise<ToolResult> {
    this.options.onEvent?.({ type: "tool_started", call: plan.call, ranInParallel });
    const result = await this.runHandler(plan);
    this.toolExecutions.push({ call: plan.call, decision: plan.decision, ranInParallel, result });
    this.options.onEvent?.({ type: "tool_completed", call: plan.call, result, ranInParallel });
    return result;
  }

  private async runHandler(plan: ToolPlan): Promise<ToolResult> {
    try {
      return await plan.entry.handler(
        plan.call,
        this.options.signal === undefined ? {} : { signal: this.options.signal }
      );
    } catch (error) {
      // Surface the failure to the model as a tool result so it can recover,
      // rather than aborting the whole loop on one bad call.
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        summary: `Tool "${plan.call.name}" failed: ${message}`,
        warnings: [message],
        provenance: []
      };
    }
  }
}

function toAssistantMessage(turn: ModelTurn): ChatMessage {
  return {
    role: "assistant",
    content: turn.text,
    ...(turn.toolCalls.length === 0 ? {} : { toolCalls: turn.toolCalls })
  };
}

function toToolMessage(call: ToolCall, result: ToolResult): ChatMessage {
  return {
    role: "tool",
    content: serializeToolResult(result),
    toolCallId: call.id,
    name: call.name
  };
}

function serializeToolResult(result: ToolResult): string {
  return JSON.stringify({
    ok: result.ok,
    summary: result.summary,
    ...(result.data === undefined ? {} : { data: result.data }),
    ...(result.warnings.length === 0 ? {} : { warnings: result.warnings })
  });
}

function unknownToolResult(call: ToolCall): ToolResult {
  return {
    ok: false,
    summary: `Unknown tool "${call.name}". It is not available in this session.`,
    warnings: [`Model requested unknown tool "${call.name}".`],
    provenance: []
  };
}

function deniedToolResult(call: ToolCall, decision: PermissionDecision): ToolResult {
  const reason = decision === "ask"
    ? "requires approval that was not granted"
    : "was denied by the active permission policy";
  return {
    ok: false,
    summary: `Tool "${call.name}" ${reason}.`,
    warnings: [`Tool "${call.name}" ${reason}.`],
    provenance: []
  };
}

function stringArg(call: ToolCall, key: string): string | undefined {
  const value = call.arguments[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function toolTarget(call: ToolCall): string | undefined {
  return stringArg(call, "path") ?? stringArg(call, "root") ?? stringArg(call, "query");
}

function riskForPermission(definition: ToolDefinition): "low" | "medium" | "high" {
  switch (definition.permission) {
    case "always_confirm":
      return "high";
    case "require_approval":
      return "medium";
    default:
      return "low";
  }
}
