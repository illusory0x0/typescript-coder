import { describe, expect, test } from "bun:test";
import { REPLAY_BUNDLE_FORMAT, ReplayRecorder } from "./replay-format";
import type { ChatMessage, ToolCall } from "../src/openai";

describe("ReplayRecorder", () => {
  test("snapshots messages at call time", () => {
    const recorder = new ReplayRecorder();
    const messages: ChatMessage[] = [{ role: "user", content: "hello" }];
    recorder.record(messages, {
      content: "world",
      toolCalls: [],
      finishReason: "stop",
      raw: { usage: { total_tokens: 7 } },
    });
    messages.push({ role: "assistant", content: "after" });
    expect(recorder.calls.length).toBe(1);
    expect(recorder.calls[0]?.messages).toEqual([{ role: "user", content: "hello" }]);
    expect(recorder.calls[0]?.content).toBe("world");
    expect(recorder.calls[0]?.finishReason).toBe("stop");
    expect(recorder.calls[0]?.usage).toEqual({ total_tokens: 7 });
  });

  test("clones tool calls in messages and responses", () => {
    const recorder = new ReplayRecorder();
    const toolCalls: ToolCall[] = [
      { id: "t1", type: "function", function: { name: "select", arguments: "{}" } },
    ];
    recorder.record([{ role: "assistant", content: null, toolCalls }], {
      content: null,
      toolCalls,
      finishReason: "tool_calls",
      raw: {},
    });
    toolCalls[0]!.function.arguments = '{"changed":true}';
    expect(recorder.calls[0]?.toolCalls[0]?.function.arguments).toBe("{}");
    expect(recorder.calls[0]?.messages[0]?.toolCalls?.[0]?.function.arguments).toBe("{}");
  });

  test("assembles a versioned bundle and nulls missing usage", () => {
    const recorder = new ReplayRecorder();
    recorder.record([], { content: "x", toolCalls: [], finishReason: null, raw: "raw" });
    expect(recorder.calls[0]?.usage).toBeNull();
    const bundle = recorder.bundle({
      task: "json-parser",
      rep: 2,
      model: "deepseek-v4.1-flash",
      issue: "issue text",
      fixture: "benchmark/fixtures/json-parser",
    });
    expect(bundle.format).toBe(REPLAY_BUNDLE_FORMAT);
    expect(bundle.side).toBe("ts");
    expect(bundle.task).toBe("json-parser");
    expect(bundle.rep).toBe(2);
    expect(bundle.calls.length).toBe(1);
  });
});
