import type {
  ChatRequest,
  ChatOptions,
  ModelAdapter,
  ModelCapabilities,
  ModelDelta,
  ModelInfo,
  ToolCall,
  ToolDefinition,
  TokenCountInput,
  TokenCountResult
} from "../types.js";

interface OllamaTagsResponse {
  models?: Array<{
    name: string;
  }>;
}

interface OllamaChatLine {
  message?: {
    content?: string;
    tool_calls?: Array<{
      function?: {
        name?: string;
        arguments?: Record<string, unknown> | string;
      };
    }>;
  };
  done?: boolean;
}

export interface OllamaAdapterOptions {
  baseUrl?: string;
}

export class OllamaAdapter implements ModelAdapter {
  readonly id = "ollama";
  readonly displayName = "Ollama";
  readonly provider = "ollama";

  private readonly baseUrl: string;

  constructor(options: OllamaAdapterOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "http://127.0.0.1:11434").replace(/\/$/, "");
  }

  async getCapabilities(modelId: string): Promise<ModelCapabilities> {
    return {
      nativeTools: modelId.includes("tool") || modelId.includes("qwen") || modelId.includes("llama"),
      parallelTools: false,
      streamingToolCalls: false,
      structuredOutput: true,
      jsonSchemaOutput: false,
      thinking: false,
      images: false,
      embeddings: false,
      recommendedContextTokens: 32000
    };
  }

  async *chat(request: ChatRequest, options: ChatOptions = {}): AsyncIterable<ModelDelta> {
    const init: RequestInit = {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages.map(toOllamaMessage),
        stream: true,
        options: {
          temperature: request.temperature ?? 0.1
        },
        tools: request.tools?.map(toOllamaToolDefinition)
      })
    };
    if (options.signal !== undefined) {
      init.signal = options.signal;
    }

    const response = await fetch(`${this.baseUrl}/api/chat`, init);

    if (!response.ok || response.body === null) {
      throw new Error(`Ollama chat failed with HTTP ${response.status}.`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length === 0) {
          continue;
        }
        const parsed = JSON.parse(trimmed) as OllamaChatLine;
        if (parsed.message?.content) {
          yield { type: "text", content: parsed.message.content };
        }
        for (const toolCall of parsed.message?.tool_calls ?? []) {
          const normalized = parseOllamaToolCall(toolCall);
          if (normalized !== undefined) {
            yield { type: "tool_call", toolCall: normalized };
          }
        }
        if (parsed.done) {
          yield { type: "done" };
        }
      }
    }
  }

  async countTokens(input: TokenCountInput): Promise<TokenCountResult> {
    const chars = input.messages.reduce((total, message) => total + message.content.length, 0);
    return {
      tokens: Math.ceil(chars / 4),
      approximate: true
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    const response = await fetch(`${this.baseUrl}/api/tags`);
    if (!response.ok) {
      throw new Error(`Ollama model listing failed with HTTP ${response.status}.`);
    }

    const data = (await response.json()) as OllamaTagsResponse;
    return (data.models ?? []).map((model) => ({
      id: model.name,
      displayName: model.name,
      provider: this.provider
    }));
  }
}

function toOllamaToolDefinition(tool: ToolDefinition): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema
    }
  };
}

function toOllamaMessage(message: ChatRequest["messages"][number]): Record<string, unknown> {
  if (message.role === "assistant" && message.toolCalls !== undefined) {
    return {
      role: "assistant",
      content: message.content,
      tool_calls: message.toolCalls.map((toolCall) => ({
        function: {
          name: toolCall.name,
          arguments: toolCall.arguments
        }
      }))
    };
  }
  if (message.role === "tool") {
    return {
      role: "tool",
      content: message.content,
      name: message.name
    };
  }
  return {
    role: message.role,
    content: message.content
  };
}

function parseOllamaToolCall(toolCall: { function?: { name?: string; arguments?: Record<string, unknown> | string } }): ToolCall | undefined {
  const name = toolCall.function?.name;
  if (name === undefined || name.trim().length === 0) {
    return undefined;
  }
  const rawArgs = toolCall.function?.arguments;
  let args: Record<string, unknown> = {};
  if (typeof rawArgs === "string" && rawArgs.trim().length > 0) {
    try {
      const parsed = JSON.parse(rawArgs) as unknown;
      args = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      args = {};
    }
  } else if (typeof rawArgs === "object" && rawArgs !== null && !Array.isArray(rawArgs)) {
    args = rawArgs;
  }
  return {
    id: `tool:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    name,
    arguments: args
  };
}
