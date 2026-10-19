import { expect, test } from "bun:test";
import { OpenAIProvider, readConfigFromEnv } from "./openai";
import type { ChatMessage, OpenAIConfig, ToolDefinition } from "./openai";

const config: OpenAIConfig = {
  apiKey: "test-key",
  baseUrl: "https://api.example.com/v1",
  model: "deepseek-v4.1-flash",
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

function queueFetch(steps: Array<() => Response>): {
  fetchImpl: typeof fetch;
  requests: CapturedRequest[];
} {
  const requests: CapturedRequest[] = [];
  let index = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    const step = steps[index];
    index += 1;
    if (step === undefined) {
      throw new Error("unexpected fetch call");
    }
    return step();
  }) as unknown as typeof fetch;
  return { fetchImpl, requests };
}

function mockSleep(): { sleep: (ms: number) => Promise<void>; delays: number[] } {
  const delays: number[] = [];
  return {
    delays,
    sleep: (ms) => {
      delays.push(ms);
      return Promise.resolve();
    },
  };
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
      OPENAI_TIMEOUT_MS: undefined,
      OPENAI_TIMEOUT_RETRIES: undefined,
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
    expect(() => readConfigFromEnv("deepseek-v4.1-flash")).toThrow("OPENAI_API_KEY is not set");
  });
});

test("readConfigFromEnv throws when OPENAI_BASE_URL is missing", () => {
  withEnv({ OPENAI_API_KEY: "key-1", OPENAI_BASE_URL: undefined }, () => {
    expect(() => readConfigFromEnv("deepseek-v4.1-flash")).toThrow("OPENAI_BASE_URL is not set");
  });
});

test("readConfigFromEnv reads OPENAI_TIMEOUT_MS as a positive integer", () => {
  withEnv(
    {
      OPENAI_API_KEY: "key-1",
      OPENAI_BASE_URL: "https://env.example.com/v1",
      OPENAI_TIMEOUT_MS: "2500",
      OPENAI_TIMEOUT_RETRIES: undefined,
    },
    () => {
      expect(readConfigFromEnv("qwen")).toEqual({
        apiKey: "key-1",
        baseUrl: "https://env.example.com/v1",
        model: "qwen",
        timeoutMs: 2500,
      });
    },
  );
});

test("readConfigFromEnv rejects an invalid OPENAI_TIMEOUT_MS", () => {
  for (const value of ["abc", "0", "-5", "1.5"]) {
    withEnv(
      {
        OPENAI_API_KEY: "key-1",
        OPENAI_BASE_URL: "https://env.example.com",
        OPENAI_TIMEOUT_MS: value,
      },
      () => {
        expect(() => readConfigFromEnv("qwen")).toThrow(
          `OPENAI_TIMEOUT_MS must be a positive integer (got "${value}")`,
        );
      },
    );
  }
});

test("readConfigFromEnv reads OPENAI_TIMEOUT_RETRIES as a non-negative integer", () => {
  withEnv(
    {
      OPENAI_API_KEY: "key-1",
      OPENAI_BASE_URL: "https://env.example.com/v1",
      OPENAI_TIMEOUT_MS: undefined,
      OPENAI_TIMEOUT_RETRIES: "3",
    },
    () => {
      expect(readConfigFromEnv("qwen")).toEqual({
        apiKey: "key-1",
        baseUrl: "https://env.example.com/v1",
        model: "qwen",
        timeoutRetries: 3,
      });
    },
  );
});

test("readConfigFromEnv rejects an invalid OPENAI_TIMEOUT_RETRIES", () => {
  for (const value of ["abc", "-1", "1.5"]) {
    withEnv(
      {
        OPENAI_API_KEY: "key-1",
        OPENAI_BASE_URL: "https://env.example.com",
        OPENAI_TIMEOUT_RETRIES: value,
      },
      () => {
        expect(() => readConfigFromEnv("qwen")).toThrow(
          `OPENAI_TIMEOUT_RETRIES must be a non-negative integer (got "${value}")`,
        );
      },
    );
  }
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
  expect(body["model"]).toBe("deepseek-v4.1-flash");
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

test("includes reasoning_effort when provided", async () => {
  const { fetchImpl, requests } = mockFetch(() => textResponse("hi"));
  const provider = new OpenAIProvider(config, fetchImpl);

  await provider.chat([{ role: "user", content: "hello" }], undefined, {
    reasoningEffort: "low",
  });

  expect(requestBody(requests[0])["reasoning_effort"]).toBe("low");
});

test("omits reasoning_effort when not provided", async () => {
  const { fetchImpl, requests } = mockFetch(() => textResponse("hi"));
  const provider = new OpenAIProvider(config, fetchImpl);

  await provider.chat([{ role: "user", content: "hello" }]);
  await provider.chat([{ role: "user", content: "hello" }], undefined, { temperature: 0 });

  expect(Object.hasOwn(requestBody(requests[0]), "reasoning_effort")).toBe(false);
  expect(Object.hasOwn(requestBody(requests[1]), "reasoning_effort")).toBe(false);
});

test("keeps reasoning_effort on a retried request", async () => {
  const { fetchImpl, requests } = queueFetch([
    () => new Response("boom", { status: 500 }),
    () => textResponse("hi"),
  ]);
  const { sleep } = mockSleep();
  const provider = new OpenAIProvider(config, fetchImpl, sleep);

  await provider.chat([{ role: "user", content: "hello" }], undefined, {
    reasoningEffort: "max",
  });

  expect(requests).toHaveLength(2);
  expect(requestBody(requests[0])["reasoning_effort"]).toBe("max");
  expect(requestBody(requests[1])["reasoning_effort"]).toBe("max");
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
  const provider = new OpenAIProvider({ ...config, retries: 0 }, fetchImpl);

  await expect(provider.chat([{ role: "user", content: "hi" }])).rejects.toThrow(
    "chat request failed: 429 rate limited",
  );
});

test("truncates a long error body", async () => {
  const { fetchImpl } = mockFetch(() => new Response("x".repeat(1000), { status: 500 }));
  const provider = new OpenAIProvider({ ...config, retries: 0 }, fetchImpl);

  await expect(provider.chat([{ role: "user", content: "hi" }])).rejects.toThrow(
    /^chat request failed: 500 x{500}$/,
  );
});

test("times out and aborts on a single attempt when timeoutRetries is 0", async () => {
  const captured: { signal: AbortSignal | null } = { signal: null };
  let calls = 0;
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    captured.signal = init?.signal ?? null;
    return new Promise<Response>(() => {});
  }) as unknown as typeof fetch;
  const { sleep } = mockSleep();
  const provider = new OpenAIProvider(
    { ...config, timeoutMs: 20, timeoutRetries: 0 },
    fetchImpl,
    sleep,
  );

  await expect(provider.chat([{ role: "user", content: "hi" }])).rejects.toThrow(
    "chat request timed out after 20 ms",
  );
  expect(captured.signal).toBeInstanceOf(AbortSignal);
  expect(captured.signal?.aborted).toBe(true);
  expect(calls).toBe(1);
});

test("retries a timed-out request and succeeds on a fresh attempt", async () => {
  const signals: AbortSignal[] = [];
  let calls = 0;
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    signals.push(init?.signal as AbortSignal);
    if (calls === 1) {
      return new Promise<Response>(() => {});
    }
    return textResponse("recovered");
  }) as unknown as typeof fetch;
  const { sleep, delays } = mockSleep();
  const provider = new OpenAIProvider({ ...config, timeoutMs: 10 }, fetchImpl, sleep);

  const response = await provider.chat([{ role: "user", content: "hi" }]);

  expect(response.content).toBe("recovered");
  expect(calls).toBe(2);
  expect(signals[0]).toBeInstanceOf(AbortSignal);
  expect(signals[0]?.aborted).toBe(true);
  expect(signals[1]).toBeInstanceOf(AbortSignal);
  expect(signals[1]?.aborted).toBe(false);
  expect(delays).toEqual([1000]);
});

test("re-sends an identical body when retrying a timeout", async () => {
  const seen: string[] = [];
  let calls = 0;
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    seen.push(String(init?.body));
    if (calls === 1) {
      return new Promise<Response>(() => {});
    }
    return textResponse("ok");
  }) as unknown as typeof fetch;
  const { sleep } = mockSleep();
  const provider = new OpenAIProvider({ ...config, timeoutMs: 10 }, fetchImpl, sleep);

  await provider.chat([{ role: "user", content: "hello" }]);

  expect(seen).toHaveLength(2);
  expect(seen[0]).toBe(seen[1]);
});

test("fails after exhausting the timeout retry budget", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Promise<Response>(() => {});
  }) as unknown as typeof fetch;
  const { sleep, delays } = mockSleep();
  const provider = new OpenAIProvider({ ...config, timeoutMs: 10 }, fetchImpl, sleep);

  await expect(provider.chat([{ role: "user", content: "hi" }])).rejects.toThrow(
    "chat request timed out after 10 ms",
  );
  expect(calls).toBe(6);
  expect(delays).toEqual([1000, 2000, 4000, 8000, 16000]);
});

test("keeps the timeout budget independent of the failure retry budget", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    if (calls === 1) {
      return new Promise<Response>(() => {});
    }
    return textResponse("recovered");
  }) as unknown as typeof fetch;
  const { sleep, delays } = mockSleep();
  // retries: 0 would forbid a failure retry, yet the timeout is still re-sent.
  const provider = new OpenAIProvider({ ...config, timeoutMs: 10, retries: 0 }, fetchImpl, sleep);

  const response = await provider.chat([{ role: "user", content: "hi" }]);

  expect(response.content).toBe("recovered");
  expect(calls).toBe(2);
  expect(delays).toEqual([1000]);
});

test("wraps fetch failures with the original message", async () => {
  const fetchImpl = (async () => {
    throw new Error("connect ECONNREFUSED");
  }) as unknown as typeof fetch;
  const provider = new OpenAIProvider({ ...config, retries: 0 }, fetchImpl);

  await expect(provider.chat([{ role: "user", content: "hi" }])).rejects.toThrow(
    "chat request failed: connect ECONNREFUSED",
  );
});

test("retries a 429 after the default backoff and succeeds", async () => {
  const { fetchImpl, requests } = queueFetch([
    () => new Response("rate limited", { status: 429 }),
    () => textResponse("hi"),
  ]);
  const { sleep, delays } = mockSleep();
  const provider = new OpenAIProvider(config, fetchImpl, sleep);

  const response = await provider.chat([{ role: "user", content: "hello" }]);

  expect(response.content).toBe("hi");
  expect(requests).toHaveLength(2);
  expect(delays).toEqual([1000]);
  expect(requestBody(requests[0])).toEqual(requestBody(requests[1]));
});

test("retries 5xx responses with exponential backoff", async () => {
  const { fetchImpl, requests } = queueFetch([
    () => new Response("boom", { status: 500 }),
    () => new Response("boom", { status: 502 }),
    () => textResponse("done"),
  ]);
  const { sleep, delays } = mockSleep();
  const provider = new OpenAIProvider(config, fetchImpl, sleep);

  const response = await provider.chat([{ role: "user", content: "hi" }]);

  expect(response.content).toBe("done");
  expect(requests).toHaveLength(3);
  expect(delays).toEqual([1000, 2000]);
});

test("fails after exhausting the default retry budget", async () => {
  const { fetchImpl, requests } = queueFetch([
    () => new Response("upstream boom", { status: 500 }),
    () => new Response("upstream boom", { status: 500 }),
    () => new Response("upstream boom", { status: 500 }),
  ]);
  const { sleep, delays } = mockSleep();
  const provider = new OpenAIProvider(config, fetchImpl, sleep);

  await expect(provider.chat([{ role: "user", content: "hi" }])).rejects.toThrow(
    "chat request failed: 500 upstream boom",
  );
  expect(requests).toHaveLength(3);
  expect(delays).toEqual([1000, 2000]);
});

test("honors Retry-After seconds on a retryable response", async () => {
  const { fetchImpl, requests } = queueFetch([
    () => new Response("rate limited", { status: 429, headers: { "retry-after": "2" } }),
    () => textResponse("hi"),
  ]);
  const { sleep, delays } = mockSleep();
  const provider = new OpenAIProvider(config, fetchImpl, sleep);

  const response = await provider.chat([{ role: "user", content: "hi" }]);

  expect(response.content).toBe("hi");
  expect(requests).toHaveLength(2);
  expect(delays).toEqual([2000]);
});

test("caps an oversized Retry-After value", async () => {
  const { fetchImpl } = queueFetch([
    () => new Response("rate limited", { status: 429, headers: { "retry-after": "999" } }),
    () => textResponse("hi"),
  ]);
  const { sleep, delays } = mockSleep();
  const provider = new OpenAIProvider(config, fetchImpl, sleep);

  await provider.chat([{ role: "user", content: "hi" }]);

  expect(delays).toEqual([10000]);
});

test("ignores an invalid Retry-After value", async () => {
  const { fetchImpl } = queueFetch([
    () => new Response("rate limited", { status: 429, headers: { "retry-after": "soon" } }),
    () => textResponse("hi"),
  ]);
  const { sleep, delays } = mockSleep();
  const provider = new OpenAIProvider(config, fetchImpl, sleep);

  await provider.chat([{ role: "user", content: "hi" }]);

  expect(delays).toEqual([1000]);
});

test("does not retry other 4xx responses", async () => {
  const { fetchImpl, requests } = queueFetch([() => new Response("bad request", { status: 400 })]);
  const { sleep, delays } = mockSleep();
  const provider = new OpenAIProvider(config, fetchImpl, sleep);

  await expect(provider.chat([{ role: "user", content: "hi" }])).rejects.toThrow(
    "chat request failed: 400 bad request",
  );
  expect(requests).toHaveLength(1);
  expect(delays).toEqual([]);
});

test("retries network-level fetch failures", async () => {
  const { fetchImpl, requests } = queueFetch([
    () => {
      throw new Error("socket hang up");
    },
    () => textResponse("recovered"),
  ]);
  const { sleep, delays } = mockSleep();
  const provider = new OpenAIProvider(config, fetchImpl, sleep);

  const response = await provider.chat([{ role: "user", content: "hi" }]);

  expect(response.content).toBe("recovered");
  expect(requests).toHaveLength(2);
  expect(delays).toEqual([1000]);
});

test("retries: 0 makes a single attempt", async () => {
  const { fetchImpl, requests } = queueFetch([() => new Response("unavailable", { status: 503 })]);
  const { sleep, delays } = mockSleep();
  const provider = new OpenAIProvider({ ...config, retries: 0 }, fetchImpl, sleep);

  await expect(provider.chat([{ role: "user", content: "hi" }])).rejects.toThrow(
    "chat request failed: 503 unavailable",
  );
  expect(requests).toHaveLength(1);
  expect(delays).toEqual([]);
});

test("rejects invalid retry counts", () => {
  const { fetchImpl } = mockFetch(() => textResponse("hi"));
  for (const retries of [-1, 1.5, Number.NaN]) {
    expect(() => new OpenAIProvider({ ...config, retries }, fetchImpl)).toThrow(
      `retries must be a non-negative integer (got ${retries})`,
    );
  }
});

test("rejects invalid timeout retry counts", () => {
  const { fetchImpl } = mockFetch(() => textResponse("hi"));
  for (const timeoutRetries of [-1, 1.5, Number.NaN]) {
    expect(() => new OpenAIProvider({ ...config, timeoutRetries }, fetchImpl)).toThrow(
      `timeoutRetries must be a non-negative integer (got ${timeoutRetries})`,
    );
  }
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
