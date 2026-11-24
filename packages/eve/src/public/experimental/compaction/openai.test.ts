import { describe, expect, it, vi } from "vitest";

import type { CompactionContext } from "#shared/compaction-strategy.js";
import type { StoredHistoryMessage } from "#shared/history-message.js";

import { rewriteOf } from "#internal/testing/openai-responses.js";

import { openaiCompaction } from "./openai.js";

const item: StoredHistoryMessage = {
  content: [
    {
      kind: "openai.compaction",
      providerOptions: { openai: { encryptedContent: "ENC", itemId: "cmp_1" } },
      type: "custom",
    },
  ],
  role: "assistant",
};
const user = (text: string): StoredHistoryMessage => ({
  content: text,
  kind: "user",
  role: "user",
});
const reply: StoredHistoryMessage = {
  content: [{ text: "Noted.", type: "text" }],
  role: "assistant",
};
const injected: StoredHistoryMessage = {
  content: "STATE-NOTE",
  kind: "context.state",
  role: "user",
};
const toolResult: StoredHistoryMessage = {
  content: [
    {
      output: { type: "text", value: "Two cases." },
      toolCallId: "call_1",
      toolName: "lookup",
      type: "tool-result",
    },
  ],
  role: "tool",
};

function context(provider = "openai.responses") {
  const call = vi.fn(async () => ({ messages: [item], text: "" }));
  const ctx = {
    abortSignal: new AbortController().signal,
    call,
    event: "model.requested",
    model: { modelId: "gpt-5", provider },
    reason: "automatic",
    recompacting: false,
    session: { id: "session" },
    tokens: { estimate: () => 0, limit: 1_000, target: 100, threshold: 500 },
  } satisfies CompactionContext;
  return { call, ctx };
}

const run = (history: StoredHistoryMessage[], ctx: CompactionContext) =>
  rewriteOf(openaiCompaction())(history, ctx);

describe("openaiCompaction() once per turn", () => {
  it.each([
    ["the item is the last message", [user("Review it."), item]],
    ["only messages eve injects follow the item", [user("Review it."), item, injected]],
  ])("declines when %s", async (_, history) => {
    const { call, ctx } = context();

    expect(await run(history, ctx)).toBeUndefined();
    expect(call).not.toHaveBeenCalled();
  });

  it.each([
    ["a tool result follows the item", [user("Review it."), item, reply, toolResult]],
    ["the user spoke after the item", [user("One."), item, reply, user("Two.")]],
    ["the history holds no item", [user("One."), reply]],
  ])("compacts when %s", async (_, history) => {
    const { call, ctx } = context();

    expect(await run(history, ctx)).toEqual([item]);
    expect(call).toHaveBeenCalledWith({
      messages: history,
      providerOptions: { openai: { compactionTrigger: true } },
      tools: "inherit",
    });
  });

  it("leaves eve's injected messages out of the request", async () => {
    const { call, ctx } = context();

    await run([user("Review it."), injected, reply], ctx);

    expect(call).toHaveBeenCalledWith(
      expect.objectContaining({ messages: [user("Review it."), reply] }),
    );
  });
});
