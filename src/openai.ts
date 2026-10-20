export interface OpenAIConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs?: number;
  /** Additional attempts after a retryable failure; defaults to 2. */
  retries?: number;
  /**
   * Additional attempts after a per-attempt timeout; defaults to 5 (#74).
   * `retries` covers network/429/5xx failures and is not consumed by timeouts.
   */
  timeoutRetries?: number;
}

export const DEFAULT_TIMEOUT_MS = 120_000;

const DEFAULT_RETRIES = 2;
const DEFAULT_TIMEOUT_RETRIES = 5;
const RETRY_BASE_DELAY_MS = 1000;
const RETRY_AFTER_MAX_MS = 10_000;

export type ReasoningEffort = "none" | "low" | "high" | "max";

export interface ChatOptions {
  temperature?: number;
  /** Sent to the API as the snake_case `reasoning_effort` field. */
  reasoningEffort?: ReasoningEffort;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  toolCallId?: string;
  name?: string;
  toolCalls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolDefinition {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatResponse {
  content: string | null;
  toolCalls: ToolCall[];
  finishReason: string | null;
  raw: unknown;
}

interface SerializedMessage {
  role: ChatMessage["role"];
  content: string | null;
  tool_call_id?: string;
  name?: string;
  tool_calls?: ToolCall[];
}

interface ChatRequestBody {
  model: string;
  messages: SerializedMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  reasoning_effort?: ReasoningEffort;
}

export function readConfigFromEnv(model: string): OpenAIConfig {
  const apiKey = process.env.OPENAI_API_KEY;
  if (apiKey === undefined || apiKey === "") {
    throw new Error("OPENAI_API_KEY is not set");
  }
  const baseUrl = process.env.OPENAI_BASE_URL;
  if (baseUrl === undefined || baseUrl === "") {
    throw new Error("OPENAI_BASE_URL is not set");
  }
  const config: OpenAIConfig = { apiKey, baseUrl: baseUrl.replace(/\/$/, ""), model };
  const timeoutText = process.env.OPENAI_TIMEOUT_MS;
  if (timeoutText !== undefined) {
    const timeoutMs = Number(timeoutText);
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error(`OPENAI_TIMEOUT_MS must be a positive integer (got "${timeoutText}")`);
    }
    config.timeoutMs = timeoutMs;
  }
  // Precedence: an explicit `timeoutRetries` on a config passed to the provider
  // wins over this env-derived value (the env var only seeds the field here).
  const timeoutRetriesText = process.env.OPENAI_TIMEOUT_RETRIES;
  if (timeoutRetriesText !== undefined) {
    const timeoutRetries = Number(timeoutRetriesText);
    if (!Number.isInteger(timeoutRetries) || timeoutRetries < 0) {
      throw new Error(
        `OPENAI_TIMEOUT_RETRIES must be a non-negative integer (got "${timeoutRetriesText}")`,
      );
    }
    config.timeoutRetries = timeoutRetries;
  }
  return config;
}

function serializeMessage(message: ChatMessage): SerializedMessage {
  const serialized: SerializedMessage = {
    role: message.role,
    content: message.content,
  };
  if (message.name !== undefined) {
    serialized.name = message.name;
  }
  if (message.role === "tool" && message.toolCallId !== undefined) {
    serialized.tool_call_id = message.toolCallId;
  }
  if (message.role === "assistant" && message.toolCalls !== undefined) {
    serialized.tool_calls = message.toolCalls.map((toolCall) => ({
      id: toolCall.id,
      type: "function",
      function: {
        name: toolCall.function.name,
        arguments: toolCall.function.arguments,
      },
    }));
  }
  return serialized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseToolCalls(value: unknown): ToolCall[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value as ToolCall[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class ChatTimeoutError extends Error {}

/** A provider reply that reports the request exceeded the model context (#97). */
export class ChatContextOverflowError extends Error {}

/** A provider reply that reports the request payload was too large (#97). */
export class ChatPayloadTooLargeError extends Error {}

/**
 * Classify a non-retryable provider failure (#97).
 *
 * Heuristic by necessity: gateways and vendors phrase these failures
 * differently, so we match known markers rather than a strict schema. Retryable
 * statuses (429/5xx) are handled before this classification and never reach it.
 */
export function classifyChatError(
  status: number,
  bodyText: string,
): "context-overflow" | "payload-too-large" | "terminal" {
  if (
    status === 413 ||
    /payload too large|request entity too large|request too large|content too large/i.test(bodyText)
  ) {
    return "payload-too-large";
  }
  if (
    /context[_ -]?length|context window|maximum context|max(imum)? tokens|too many tokens|token limit|reduce the length|too long/i.test(
      bodyText,
    )
  ) {
    return "context-overflow";
  }
  return "terminal";
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function retryAfterMs(header: string | null): number | null {
  if (header === null) {
    return null;
  }
  const text = header.trim();
  if (!/^\d+$/.test(text)) {
    return null;
  }
  return Math.min(Number(text) * 1000, RETRY_AFTER_MAX_MS);
}

function backoffMs(attempt: number): number {
  return RETRY_BASE_DELAY_MS * 2 ** attempt;
}

export class OpenAIProvider {
  private readonly config: OpenAIConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    config: OpenAIConfig,
    fetchImpl: typeof fetch = fetch,
    sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {
    if (config.retries !== undefined && (!Number.isInteger(config.retries) || config.retries < 0)) {
      throw new Error(`retries must be a non-negative integer (got ${config.retries})`);
    }
    if (
      config.timeoutRetries !== undefined &&
      (!Number.isInteger(config.timeoutRetries) || config.timeoutRetries < 0)
    ) {
      throw new Error(
        `timeoutRetries must be a non-negative integer (got ${config.timeoutRetries})`,
      );
    }
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.sleep = sleep;
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const timeoutMs = this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new ChatTimeoutError(`chat request timed out after ${timeoutMs} ms`));
      }, timeoutMs);
    });
    try {
      return await Promise.race([
        this.fetchImpl(url, { ...init, signal: controller.signal }),
        timeout,
      ]);
    } catch (error) {
      if (timedOut) {
        throw new ChatTimeoutError(`chat request timed out after ${timeoutMs} ms`);
      }
      throw new Error(`chat request failed: ${errorMessage(error)}`);
    } finally {
      if (timer !== null) {
        clearTimeout(timer);
      }
    }
  }

  async chat(
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    options?: ChatOptions,
  ): Promise<ChatResponse> {
    const body: ChatRequestBody = {
      model: this.config.model,
      messages: messages.map(serializeMessage),
    };
    if (tools !== undefined && tools.length > 0) {
      body.tools = tools;
    }
    if (options?.temperature !== undefined) {
      body.temperature = options.temperature;
    }
    if (options?.reasoningEffort !== undefined) {
      body.reasoning_effort = options.reasoningEffort;
    }

    const url = `${this.config.baseUrl}/chat/completions`;
    const init: RequestInit = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(body),
    };
    const retries = this.config.retries ?? DEFAULT_RETRIES;
    const timeoutRetries = this.config.timeoutRetries ?? DEFAULT_TIMEOUT_RETRIES;
    let failures = 0;
    let timeouts = 0;

    for (let attempt = 0; ; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetchWithTimeout(url, init);
      } catch (error) {
        // #74: a per-attempt timeout is re-sent under its own budget.
        if (error instanceof ChatTimeoutError) {
          if (timeouts >= timeoutRetries) {
            throw error;
          }
          timeouts += 1;
          await this.sleep(backoffMs(attempt));
          continue;
        }
        if (failures >= retries) {
          throw error;
        }
        failures += 1;
        await this.sleep(backoffMs(attempt));
        continue;
      }

      if (!response.ok) {
        const bodyText = await response.text();
        if (!isRetryableStatus(response.status) || failures >= retries) {
          const snippet = bodyText.slice(0, 500);
          switch (classifyChatError(response.status, bodyText)) {
            case "context-overflow":
              throw new ChatContextOverflowError(
                `chat request failed: ${response.status} context overflow: ${snippet}`,
              );
            case "payload-too-large":
              throw new ChatPayloadTooLargeError(
                `chat request failed: ${response.status} payload too large: ${snippet}`,
              );
            default:
              throw new Error(`chat request failed: ${response.status} ${snippet}`);
          }
        }
        failures += 1;
        const retryAfter = retryAfterMs(response.headers.get("retry-after"));
        await this.sleep(retryAfter ?? backoffMs(attempt));
        continue;
      }

      let raw: unknown;
      try {
        raw = await response.json();
      } catch {
        throw new Error("chat response is not valid JSON");
      }

      if (!isRecord(raw)) {
        throw new Error("chat response is not a JSON object");
      }
      const choices = raw["choices"];
      if (!Array.isArray(choices) || choices.length === 0) {
        throw new Error("chat response has no choices");
      }
      const choice = choices[0];
      if (!isRecord(choice) || !isRecord(choice["message"])) {
        throw new Error("chat response choice has no message");
      }
      const message = choice["message"];
      const content = message["content"];
      const finishReason = choice["finish_reason"];
      return {
        content: typeof content === "string" ? content : null,
        toolCalls: parseToolCalls(message["tool_calls"]),
        finishReason: typeof finishReason === "string" ? finishReason : null,
        raw,
      };
    }
  }
}
