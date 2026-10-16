import { expect, test } from "bun:test";
import { OpenAIProvider, readConfigFromEnv } from "./openai";
import type { ChatMessage, OpenAIConfig, ToolDefinition } from "./openai";

const config: OpenAIConfig = {
  apiKey: "test-key",
  baseUrl: "https://api.example.com/v1",
  model: "deepseek",
};

interface CapturedRequest {
  url: string;
  init: RequestInit | undefined;
}

function mockFetch(responseFactory: () => Response): {
  fetchImpl: typeof fetch;
  requests: CapturedRequest[];
} {
  const requests: CapturedRequest[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    return responseFactory();
  }) as unknown as typeof fetch;
  return { fetchImpl, requests };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(content: string): Response {
  return jsonResponse({
    choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
  });
}

function requestBody(request: CapturedRequest | undefined): Record<string, unknown> {
  if (request === undefined || request.init?.body === undefined || request.init.body === null) {
    throw new Error("missing captured request body");
  }
  return JSON.parse(String(request.init.body)) as Record<string, unknown>;
}

function withEnv(values: Record<string, string | undefined>, run: () => void): void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("readConfigFromEnv reads credentials and trims a trailing slash", () => {
  withEnv(
    {
      OPENAI_API_KEY: "key-1",
      OPENAI_BASE_URL: "https://env.example.com/v1/",
    },
    () => {
      expect(readConfigFromEnv("qwen")).toEqual({
        apiKey: "key-1",
        baseUrl: "https://env.example.com/v1",
        model: "qwen",
      });
    },
  );
});

test("readConfigFromEnv throws when OPENAI_API_KEY is missing", () => {
  withEnv({ OPENAI_API_KEY: undefined, OPENAI_BASE_URL: "https://env.example.com" }, () => {
    expect(() => readConfigFromEnv("deepseek")).toThrow("OPENAI_API_KEY is not set");
  });
});

test("readConfigFromEnv throws when OPENAI_BASE_URL is missing", () => {
  withEnv({ OPENAI_API_KEY: "key-1", OPENAI_BASE_URL: undefined }, () => {
    expect(() => readConfigFromEnv("deepseek")).toThrow("OPENAI_BASE_URL is not set");
  });
});

test("posts chat completions to the configured endpoint with auth headers", async () => {
  const { fetchImpl, requests } = mockFetch(() => textResponse("hi"));
  const provider = new OpenAIProvider(config, fetchImpl);
  const messages: ChatMessage[] = [
    { role: "system", content: "be brief" },
    { role: "user", content: "hello" },
  ];

  await provider.chat(messages);

  expect(requests).toHaveLength(1);
  const request = requests[0];
  expect(request?.url).toBe("https://api.example.com/v1/chat/completions");
  expect(request?.init?.method).toBe("POST");
  const headers = request?.init?.headers as Record<string, string>;
  expect(headers["content-type"]).toBe("application/json");
  expect(headers["authorization"]).toBe("Bearer test-key");

  const body = requestBody(request);
  expect(body["model"]).toBe("deepseek");
  expect(body["messages"]).toEqual([
    { role: "system", content: "be brief" },
    { role: "user", content: "hello" },
  ]);
});

test("includes tools when provided", async () => {
  const tools: ToolDefinition[] = [
    {
      type: "function",
      function: {
        name: "find_definition",
        description: "Find a symbol definition",
        parameters: { type: "object", properties: { name: { type: "string" } } },
      },
    },
  ];
  const { fetchImpl, requests } = mockFetch(() => textResponse("hi"));
  const provider = new OpenAIProvider(config, fetchImpl);

  await provider.chat([{ role: "user", content: "hello" }], tools);

  expect(requestBody(requests[0])["tools"]).toEqual(tools);
});

test("omits tools when absent or empty", async () => {
  const { fetchImpl, requests } = mockFetch(() => textResponse("hi"));
  const provider = new OpenAIProvider(config, fetchImpl);

  await provider.chat([{ role: "user", content: "hello" }]);
  await provider.chat([{ role: "user", content: "hello" }], []);

  expect(Object.hasOwn(requestBody(requests[0]), "tools")).toBe(false);
  expect(Object.hasOwn(requestBody(requests[1]), "tools")).toBe(false);
});

test("includes temperature only when provided", async () => {
  const { fetchImpl, requests } = mockFetch(() => textResponse("hi"));
  const provider = new OpenAIProvider(config, fetchImpl);

  await provider.chat([{ role: "user", content: "hello" }]);
  await provider.chat([{ role: "user", content: "hello" }], undefined, { temperature: 0 });

  expect(Object.hasOwn(requestBody(requests[0]), "temperature")).toBe(false);
  expect(requestBody(requests[1])["temperature"]).toBe(0);
});

test("maps content, tool calls, and finish reason from the response", async () => {
  const payload = {
    id: "chatcmpl-1",
    choices: [
      {
        message: {
          role: "assistant",
          content: "working",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "check", arguments: '{"path":"a.ts"}' },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  };
  const { fetchImpl } = mockFetch(() => jsonResponse(payload));
  const provider = new OpenAIProvider(config, fetchImpl);

  const response = await provider.chat([{ role: "user", content: "fix it" }]);

  expect(response.content).toBe("working");
  expect(response.toolCalls).toEqual([
    { id: "call_1", type: "function", function: { name: "check", arguments: '{"path":"a.ts"}' } },
  ]);
  expect(response.finishReason).toBe("tool_calls");
  expect(response.raw).toEqual(payload);
});

test("returns null content and empty tool calls when absent", async () => {
  const { fetchImpl } = mockFetch(() =>
    jsonResponse({ choices: [{ message: { content: null }, finish_reason: null }] }),
  );
  const provider = new OpenAIProvider(config, fetchImpl);

  const response = await provider.chat([{ role: "user", content: "hi" }]);

  expect(response.content).toBeNull();
  expect(response.toolCalls).toEqual([]);
  expect(response.finishReason).toBeNull();
});

test("serializes assistant tool calls and tool results", async () => {
  const toolCalls = [
    { id: "call_1", type: "function" as const, function: { name: "check", arguments: "{}" } },
  ];
  const messages: ChatMessage[] = [
    { role: "assistant", content: null, toolCalls },
    { role: "tool", content: "ok", toolCallId: "call_1", name: "check" },
  ];
  const { fetchImpl, requests } = mockFetch(() => textResponse("done"));
  const provider = new OpenAIProvider(config, fetchImpl);

  await provider.chat(messages);

  expect(requestBody(requests[0])["messages"]).toEqual([
    { role: "assistant", content: null, tool_calls: toolCalls },
    { role: "tool", content: "ok", tool_call_id: "call_1", name: "check" },
  ]);
});

test("rejects with status and body on a non-2xx response", async () => {
  const { fetchImpl } = mockFetch(() => new Response("rate limited", { status: 429 }));
  const provider = new OpenAIProvider(config, fetchImpl);

  await expect(provider.chat([{ role: "user", content: "hi" }])).rejects.toThrow(
    "chat request failed: 429 rate limited",
  );
});

test("truncates a long error body", async () => {
  const { fetchImpl } = mockFetch(() => new Response("x".repeat(1000), { status: 500 }));
  const provider = new OpenAIProvider(config, fetchImpl);

  await expect(provider.chat([{ role: "user", content: "hi" }])).rejects.toThrow(
    /^chat request failed: 500 x{500}$/,
  );
});

test("rejects when the response body is not JSON", async () => {
  const { fetchImpl } = mockFetch(() => new Response("not json", { status: 200 }));
  const provider = new OpenAIProvider(config, fetchImpl);

  await expect(provider.chat([{ role: "user", content: "hi" }])).rejects.toThrow(
    "chat response is not valid JSON",
  );
});

test("rejects when the response has no choices", async () => {
  const { fetchImpl } = mockFetch(() => jsonResponse({ id: "chatcmpl-1" }));
  const provider = new OpenAIProvider(config, fetchImpl);

  await expect(provider.chat([{ role: "user", content: "hi" }])).rejects.toThrow(
    "chat response has no choices",
  );
});

test("rejects when a choice has no message", async () => {
  const { fetchImpl } = mockFetch(() => jsonResponse({ choices: [{}] }));
  const provider = new OpenAIProvider(config, fetchImpl);

  await expect(provider.chat([{ role: "user", content: "hi" }])).rejects.toThrow(
    "chat response choice has no message",
  );
});
