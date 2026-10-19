import type { ChatMessage, ChatResponse, ToolCall } from "../src/openai";

export const REPLAY_BUNDLE_FORMAT = "typescript-coder-replay@1";

export interface ReplayCall {
  readonly messages: ChatMessage[];
  readonly content: string | null;
  readonly toolCalls: ToolCall[];
  readonly finishReason: string | null;
  readonly usage: unknown;
}

export interface ReplayBundleMeta {
  readonly task: string;
  readonly rep: number;
  readonly model: string;
  readonly issue: string;
  readonly fixture: string;
}

export interface ReplayBundle extends ReplayBundleMeta {
  readonly format: string;
  readonly side: "tc";
  readonly calls: ReplayCall[];
}

export function usageFromRaw(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const usage = (raw as Record<string, unknown>)["usage"];
  return usage === undefined ? null : usage;
}

function cloneToolCall(toolCall: ToolCall): ToolCall {
  return {
    id: toolCall.id,
    type: toolCall.type,
    function: {
      name: toolCall.function.name,
      arguments: toolCall.function.arguments,
    },
  };
}

function cloneMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => {
    const clone: ChatMessage = { role: message.role, content: message.content };
    if (message.toolCallId !== undefined) {
      clone.toolCallId = message.toolCallId;
    }
    if (message.name !== undefined) {
      clone.name = message.name;
    }
    if (message.toolCalls !== undefined) {
      clone.toolCalls = message.toolCalls.map(cloneToolCall);
    }
    return clone;
  });
}

export class ReplayRecorder {
  readonly calls: ReplayCall[] = [];

  record(messages: ChatMessage[], response: ChatResponse): void {
    this.calls.push({
      messages: cloneMessages(messages),
      content: response.content,
      toolCalls: response.toolCalls.map(cloneToolCall),
      finishReason: response.finishReason,
      usage: usageFromRaw(response.raw),
    });
  }

  bundle(meta: ReplayBundleMeta): ReplayBundle {
    return {
      format: REPLAY_BUNDLE_FORMAT,
      side: "tc",
      task: meta.task,
      rep: meta.rep,
      model: meta.model,
      issue: meta.issue,
      fixture: meta.fixture,
      calls: this.calls,
    };
  }
}
