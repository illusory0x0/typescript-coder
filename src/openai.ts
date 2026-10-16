export interface OpenAIConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
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
  return { apiKey, baseUrl: baseUrl.replace(/\/$/, ""), model };
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

export class OpenAIProvider {
  private readonly config: OpenAIConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(config: OpenAIConfig, fetchImpl: typeof fetch = fetch) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  async chat(
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    options?: { temperature?: number },
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

    const response = await this.fetchImpl(`${this.config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const bodyText = await response.text();
      throw new Error(`chat request failed: ${response.status} ${bodyText.slice(0, 500)}`);
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
