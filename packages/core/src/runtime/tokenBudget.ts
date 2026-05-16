import type { ChatMessage, ModelAdapter, ProviderId } from "../types.js";

export interface TokenCostRate {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
}

export interface TokenBudgetConfig {
  hardTokenCap?: number;
  unlimited?: boolean;
  warningThresholds?: number[];
  costRate?: TokenCostRate;
}

export interface TokenUsageTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  approximate: boolean;
}

export interface TokenBudgetWarning {
  threshold: number;
  message: string;
}

export interface TokenBudgetState extends TokenUsageTotals {
  hardTokenCap: number;
  remainingTokens: number;
  unlimited: boolean;
  warnings: TokenBudgetWarning[];
  blocked: boolean;
  blockedReason?: string;
}

export interface TokenModelCall {
  label: string;
  provider: ProviderId;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  approximate: boolean;
}

export class TokenBudgetExceededError extends Error {
  constructor(readonly state: TokenBudgetState, message: string) {
    super(message);
    this.name = "TokenBudgetExceededError";
  }
}

export class TokenBudgetTracker {
  private readonly hardTokenCap: number;
  private readonly unlimited: boolean;
  private readonly warningThresholds: number[];
  private readonly costRate: TokenCostRate;
  private readonly emittedThresholds = new Set<number>();
  private inputTokens = 0;
  private outputTokens = 0;
  private estimatedCostUsd = 0;
  private approximate = false;
  private blockedReason: string | undefined;
  readonly calls: TokenModelCall[] = [];
  readonly warnings: TokenBudgetWarning[] = [];

  constructor(config: TokenBudgetConfig) {
    this.unlimited = config.unlimited === true;
    this.hardTokenCap = this.unlimited ? 0 : Math.max(1, Math.floor(config.hardTokenCap ?? 32000));
    this.warningThresholds = (config.warningThresholds ?? [0.7, 0.9])
      .filter((threshold) => threshold > 0 && threshold < 1)
      .sort((left, right) => left - right);
    this.costRate = config.costRate ?? { inputUsdPerMillion: 0, outputUsdPerMillion: 0 };
  }

  async prepareModelCall(options: {
    adapter: ModelAdapter;
    modelId: string;
    label: string;
    messages: ChatMessage[];
  }): Promise<{ inputTokens: number; approximate: boolean }> {
    if (this.unlimited) {
      return { inputTokens: 0, approximate: false };
    }

    const counted = await options.adapter.countTokens({ messages: options.messages });
    const inputTokens = Math.max(0, counted.tokens);
    const projectedTotal = this.totalTokens + inputTokens;
    if (projectedTotal > this.hardTokenCap) {
      this.blockedReason = `${options.label} would use ${projectedTotal} token(s), exceeding the hard cap of ${this.hardTokenCap}.`;
      throw new TokenBudgetExceededError(this.snapshot(), this.blockedReason);
    }

    this.inputTokens += inputTokens;
    this.approximate = this.approximate || counted.approximate;
    this.estimatedCostUsd += costForTokens(inputTokens, this.costRate.inputUsdPerMillion);
    this.emitThresholdWarnings();
    return { inputTokens, approximate: counted.approximate };
  }

  async completeModelCall(options: {
    adapter: ModelAdapter;
    modelId: string;
    label: string;
    response: string;
    inputTokens: number;
    inputApproximate: boolean;
  }): Promise<TokenModelCall> {
    if (this.unlimited) {
      const call: TokenModelCall = {
        label: options.label,
        provider: options.adapter.provider,
        modelId: options.modelId,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0,
        approximate: false
      };
      this.calls.push(call);
      return call;
    }

    const counted = await options.adapter.countTokens({
      messages: [{ role: "assistant", content: options.response }]
    });
    const outputTokens = Math.max(0, counted.tokens);
    const estimatedCostUsd = costForTokens(options.inputTokens, this.costRate.inputUsdPerMillion)
      + costForTokens(outputTokens, this.costRate.outputUsdPerMillion);

    this.outputTokens += outputTokens;
    this.approximate = this.approximate || options.inputApproximate || counted.approximate;
    this.estimatedCostUsd += costForTokens(outputTokens, this.costRate.outputUsdPerMillion);

    const call: TokenModelCall = {
      label: options.label,
      provider: options.adapter.provider,
      modelId: options.modelId,
      inputTokens: options.inputTokens,
      outputTokens,
      estimatedCostUsd,
      approximate: options.inputApproximate || counted.approximate
    };
    this.calls.push(call);
    this.emitThresholdWarnings();
    return call;
  }

  snapshot(): TokenBudgetState {
    const totalTokens = this.totalTokens;
    return {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      totalTokens,
      estimatedCostUsd: Number(this.estimatedCostUsd.toFixed(8)),
      approximate: this.approximate,
      hardTokenCap: this.hardTokenCap,
      remainingTokens: this.unlimited ? 0 : Math.max(0, this.hardTokenCap - totalTokens),
      unlimited: this.unlimited,
      warnings: [...this.warnings],
      blocked: this.blockedReason !== undefined,
      ...(this.blockedReason === undefined ? {} : { blockedReason: this.blockedReason })
    };
  }

  private get totalTokens(): number {
    return this.inputTokens + this.outputTokens;
  }

  private emitThresholdWarnings(): void {
    if (this.unlimited) {
      return;
    }

    const ratio = this.totalTokens / this.hardTokenCap;
    for (const threshold of this.warningThresholds) {
      if (ratio < threshold || this.emittedThresholds.has(threshold)) {
        continue;
      }
      this.emittedThresholds.add(threshold);
      this.warnings.push({
        threshold,
        message: `Token budget reached ${Math.round(threshold * 100)}% (${this.totalTokens}/${this.hardTokenCap}).`
      });
    }
  }
}

function costForTokens(tokens: number, usdPerMillion: number): number {
  return (tokens / 1_000_000) * Math.max(0, usdPerMillion);
}
