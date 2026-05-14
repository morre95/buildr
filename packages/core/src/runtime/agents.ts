import { createTextPatch, type TextPatch } from "../diff/textPatch.js";
import { LM_STUDIO_CONTEXT_SLOT_DIAGNOSTIC, isProviderContextError, providerContextWarnings, providerErrorMessage } from "../providers/errors.js";
import type { Provenance } from "../types.js";
import { BuildrCore } from "./buildrCore.js";
import { TokenBudgetTracker, type TokenBudgetConfig, type TokenBudgetState, type TokenModelCall } from "./tokenBudget.js";

export interface ChatTranscriptMessage {
  role: "user" | "assistant" | "system";
  text: string;
}

export interface CompactedAgentContext {
  text: string;
  omittedMessages: number;
  omittedChars: number;
}

export interface SubAgentTask {
  id: string;
  title: string;
  path: string;
  currentContent: string;
  contextSummary?: string;
  consultedFiles?: string[];
}

export interface SubAgentResult {
  id: string;
  title: string;
  status: "completed" | "failed" | "blocked";
  summary: string;
  warnings: string[];
  provenance: Provenance[];
  patch?: TextPatch;
  tokenCall?: TokenModelCall;
}

export interface MainAgentSessionOptions {
  core: BuildrCore;
  modelId: string;
  goal: string;
  contextSummary?: string;
  transcript?: ChatTranscriptMessage[];
  tasks: SubAgentTask[];
  maxParallelSubAgents?: number;
  tokenBudget: TokenBudgetConfig;
  onTokenBudgetUpdate?: (state: TokenBudgetState) => void;
  signal?: AbortSignal;
}

export interface MainAgentSessionReport {
  goal: string;
  compactedContext: CompactedAgentContext;
  subAgents: SubAgentResult[];
  patchProposals: TextPatch[];
  tokenBudget: TokenBudgetState;
  warnings: string[];
}

export class MainAgentSession {
  private readonly budget: TokenBudgetTracker;

  constructor(private readonly options: MainAgentSessionOptions) {
    this.budget = new TokenBudgetTracker(options.tokenBudget);
  }

  async run(): Promise<MainAgentSessionReport> {
    const compactOptions = {
      goal: this.options.goal,
      transcript: this.options.transcript ?? []
    };
    const compactedContext = compactAgentContext(this.options.contextSummary === undefined ? compactOptions : {
      ...compactOptions,
      contextSummary: this.options.contextSummary
    });
    const maxParallel = Math.max(1, Math.floor(this.options.maxParallelSubAgents ?? 3));
    const initialSubAgents = await runBoundedParallel(
      this.options.tasks,
      maxParallel,
      async (task) => {
        const result = await this.runSubAgent(task, "initial");
        this.options.onTokenBudgetUpdate?.(this.budget.snapshot());
        return result;
      }
    );
    const subAgents = [...initialSubAgents];
    for (const [index, result] of initialSubAgents.entries()) {
      if (!shouldRetryWithCompactContext(result)) {
        continue;
      }
      const retry = await this.runSubAgent(createCompactRetryTask(this.options.tasks[index]!), "retry");
      this.options.onTokenBudgetUpdate?.(this.budget.snapshot());
      subAgents[index] = retry.status === "completed"
        ? {
          ...retry,
          warnings: [
            `Retried ${retry.id} serially with compact context after provider context/KV failure.`,
            ...retry.warnings
          ]
        }
        : {
          ...retry,
          warnings: [
            ...retry.warnings,
            LM_STUDIO_CONTEXT_SLOT_DIAGNOSTIC
          ].filter(uniqueWarning)
        };
    }
    const patchProposals = subAgents.flatMap((result) => result.patch === undefined ? [] : [result.patch]);
    const warnings = [
      ...this.budget.snapshot().warnings.map((warning) => warning.message),
      ...subAgents.flatMap((result) => result.warnings)
    ];

    return {
      goal: this.options.goal,
      compactedContext,
      subAgents,
      patchProposals,
      tokenBudget: this.budget.snapshot(),
      warnings
    };
  }

  private async runSubAgent(task: SubAgentTask, attempt: "initial" | "retry"): Promise<SubAgentResult> {
    try {
      if (this.options.signal?.aborted) {
        return blockedSubAgent(task, "Sub-agent was cancelled before starting.");
      }

      const rewriteOptions = {
        goal: createSubAgentGoal(this.options.goal, task, attempt),
        modelId: this.options.modelId,
        path: task.path,
        currentContent: task.currentContent,
        budget: this.budget,
        budgetLabel: `sub_agent.${task.id}`,
        ...(this.options.signal === undefined ? {} : { signal: this.options.signal })
      };
      const contextSummary = createSubAgentContext(task);
      const rewrite = await this.options.core.createFileRewriteFromModel(contextSummary === undefined ? rewriteOptions : {
        ...rewriteOptions,
        contextSummary
      });
      const patch = createTextPatch(task.path, task.currentContent, rewrite.updatedContent);
      return {
        id: task.id,
        title: task.title,
        status: "completed",
        summary: rewrite.summary,
        warnings: rewrite.warnings,
        provenance: [{ kind: "model", source: `sub_agent.${task.id}` }, { kind: "file", source: task.path }],
        patch,
        ...(rewrite.tokenCall === undefined ? {} : { tokenCall: rewrite.tokenCall })
      };
    } catch (error) {
      const message = providerErrorMessage(error);
      return {
        id: task.id,
        title: task.title,
        status: message.includes("hard cap") || message.includes("exceeding the hard cap") ? "blocked" : "failed",
        summary: message,
        warnings: providerContextWarnings(error).length === 0 ? [message] : providerContextWarnings(error),
        provenance: [{ kind: "model", source: `sub_agent.${task.id}` }, { kind: "file", source: task.path }]
      };
    }
  }
}

export function compactAgentContext(options: {
  goal: string;
  contextSummary?: string;
  transcript: ChatTranscriptMessage[];
  maxChars?: number;
}): CompactedAgentContext {
  const maxChars = options.maxChars ?? 6000;
  const header = [
    `Current goal: ${options.goal}`,
    "",
    "Workspace context:",
    summarizeText(options.contextSummary ?? "No workspace context summary is available.", 2400)
  ].join("\n");
  let remaining = Math.max(0, maxChars - header.length);
  const kept: string[] = [];
  let omittedMessages = 0;
  let omittedChars = 0;

  for (const message of [...options.transcript].reverse()) {
    const text = `${message.role}: ${summarizeText(message.text, 900)}`;
    if (text.length + 2 > remaining) {
      omittedMessages += 1;
      omittedChars += message.text.length;
      continue;
    }
    kept.unshift(text);
    remaining -= text.length + 2;
  }

  const omitted = omittedMessages === 0
    ? ""
    : `\n\nCompaction note: omitted ${omittedMessages} older message(s), ${omittedChars} character(s).`;
  const transcript = kept.length === 0 ? "" : `\n\nRecent compacted transcript:\n${kept.join("\n\n")}`;
  return {
    text: `${header}${transcript}${omitted}`,
    omittedMessages,
    omittedChars
  };
}

async function runBoundedParallel<TInput, TOutput>(
  inputs: TInput[],
  concurrency: number,
  run: (input: TInput) => Promise<TOutput>
): Promise<TOutput[]> {
  const results = new Map<number, TOutput>();
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, inputs.length) }, async () => {
    while (nextIndex < inputs.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results.set(currentIndex, await run(inputs[currentIndex]!));
    }
  });
  await Promise.all(workers);
  return inputs.map((_, index) => {
    const result = results.get(index);
    if (result === undefined) {
      throw new Error(`Parallel worker did not produce result ${index}.`);
    }
    return result;
  });
}

function summarizeText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const head = Math.floor(maxChars * 0.65);
  const tail = Math.max(0, maxChars - head - 80);
  return `${text.slice(0, head)}\n...[${text.length - head - tail} chars compacted]...\n${text.slice(text.length - tail)}`;
}

function createSubAgentGoal(goal: string, task: SubAgentTask, attempt: "initial" | "retry"): string {
  return [
    goal,
    "",
    `Sub-agent assignment: ${task.title}`,
    `Target file: ${task.path}`,
    attempt === "retry" ? "Retry mode: use compact context only and keep the response focused on this target file." : "",
    task.currentContent.trim().length === 0
      ? "The target file is empty or missing; create the complete file if this assignment requires it."
      : "Rewrite only the target file."
  ].filter((part) => part.length > 0).join("\n");
}

function createSubAgentContext(task: SubAgentTask): string | undefined {
  const parts: string[] = [];
  if (task.contextSummary !== undefined && task.contextSummary.trim().length > 0) {
    parts.push(task.contextSummary);
  }
  if (task.consultedFiles !== undefined && task.consultedFiles.length > 0) {
    parts.push([
      "Consulted files:",
      ...task.consultedFiles.map((file) => `- ${file}`)
    ].join("\n"));
  }
  return parts.length === 0 ? undefined : parts.join("\n\n");
}

function createCompactRetryTask(task: SubAgentTask): SubAgentTask {
  return {
    ...task,
    ...(task.contextSummary === undefined ? {} : { contextSummary: summarizeText(task.contextSummary, 1200) }),
    ...(task.consultedFiles === undefined ? {} : { consultedFiles: task.consultedFiles.slice(0, 8) })
  };
}

function shouldRetryWithCompactContext(result: SubAgentResult): boolean {
  return result.status === "failed" && isProviderContextError(result.summary);
}

function uniqueWarning(warning: string, index: number, warnings: string[]): boolean {
  return warnings.indexOf(warning) === index;
}

function blockedSubAgent(task: SubAgentTask, summary: string): SubAgentResult {
  return {
    id: task.id,
    title: task.title,
    status: "blocked",
    summary,
    warnings: [summary],
    provenance: [{ kind: "file", source: task.path }]
  };
}
