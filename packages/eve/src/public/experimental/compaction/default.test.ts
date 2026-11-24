import { describe, expect, it, vi } from "vitest";

import { createFrameworkUserMessage } from "#harness/messages.js";
import { estimateTokens } from "#harness/token-estimate.js";
import type {
  CompactionCallRequest,
  CompactionContext,
  CompactionReason,
} from "#shared/compaction-strategy.js";
import type { StoredHistoryMessage } from "#shared/history-message.js";

import {
  COMPACTION_PROMPT_ENVELOPE,
  COMPACTION_PROMPT_OVERHEAD_TOKENS,
} from "./checkpoint-prompt.js";
import { checkpointHead } from "./default-engine.js";
import { defaultCompaction } from "./default.js";

const user = (text: string): StoredHistoryMessage => ({
  content: text,
  kind: "user",
  role: "user",
});
const answer = (text: string): StoredHistoryMessage => ({
  content: [{ text, type: "text" }],
  role: "assistant",
});
const toolTurn = (id: string): StoredHistoryMessage[] => [
  {
    content: [{ input: {}, toolCallId: id, toolName: "lookup", type: "tool-call" }],
    role: "assistant",
  },
  {
    content: [
      {
        output: { type: "text", value: `result ${id}` },
        toolCallId: id,
        toolName: "lookup",
        type: "tool-result",
      },
    ],
    role: "tool",
  },
];
const filler = "Alice reviewed the quarterly numbers. ".repeat(400);

function context(reason: CompactionReason, recompacting = false) {
  const requests: CompactionCallRequest[] = [];
  const call = vi.fn(async (request: CompactionCallRequest) => {
    requests.push(request);
    return { messages: [answer("SUMMARY")], text: "SUMMARY" };
  });
  const ctx: CompactionContext = {
    abortSignal: new AbortController().signal,
    call,
    event: reason === "manual" ? undefined : "model.requested",
    model: { modelId: "gpt-5", provider: "openai.responses" },
    reason,
    recompacting,
    session: { id: "session" },
    tokens: { estimate: estimateTokens, limit: 100_000, target: 20_000, threshold: 30_000 },
  };
  return { ctx, requests };
}

const compact = async (history: readonly StoredHistoryMessage[], ctx: CompactionContext) => {
  const strategy = defaultCompaction();
  const rewrite = typeof strategy === "function" ? strategy : strategy.compact;
  return [...(await rewrite(history, ctx))!];
};

describe("defaultCompaction()", () => {
  it("summarizes through ctx.call() and keeps the checkpoint head first", async () => {
    const { ctx, requests } = context("automatic");

    const kept = await compact(
      [user("First."), answer(filler), user("Second."), answer(filler), user("Now.")],
      ctx,
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]!.tools).toBeUndefined();
    expect(kept.slice(0, 2)).toEqual(checkpointHead("SUMMARY"));
    expect(kept.at(-1)).toEqual(user("Now."));
  });

  it("adds the author's instructions to eve's checkpoint prompt", async () => {
    const { ctx, requests } = context("automatic");
    const strategy = defaultCompaction({ instructions: "Keep every ticket ID." });
    const rewrite = typeof strategy === "function" ? strategy : strategy.compact;

    await rewrite([user("First."), answer(filler), user("Now.")], ctx);

    expect(requests[0]!.system).toContain("Keep every ticket ID.");
  });

  describe("when a rewrite did not hold for one response", () => {
    const recent = [user("Read it."), ...toolTurn("a"), answer("Done."), user("Now.")];
    const earlier = [user("Old notes."), answer(filler), ...recent];
    const hasTool = (history: readonly StoredHistoryMessage[]) =>
      history.some((message) => message.role === "tool");

    it("escalates from the verbatim tail to the text tail to the summary alone", async () => {
      const first = await compact(earlier, context("automatic").ctx);
      const second = await compact(first, context("automatic", true).ctx);
      const third = await compact(second, context("automatic", true).ctx);

      expect(hasTool(first)).toBe(true);
      expect(hasTool(second)).toBe(false);
      expect(second.length).toBeGreaterThan(3);
      expect(third).toEqual([...checkpointHead("SUMMARY"), user("Now.")]);
    });

    it("starts at the verbatim tail when the previous rewrite held", async () => {
      const withHead = [...(checkpointHead("EARLIER") as StoredHistoryMessage[]), ...recent];

      expect(hasTool(await compact(withHead, context("automatic").ctx))).toBe(true);
      expect(hasTool(await compact(withHead, context("overflow").ctx))).toBe(true);
    });

    it("starts at the verbatim tail when the history has no checkpoint to escalate from", async () => {
      expect(hasTool(await compact(recent, context("automatic", true).ctx))).toBe(true);
    });

    it("goes to the summary alone when the previous tail held no tool turn", async () => {
      const kept = await compact(
        [
          ...(checkpointHead("EARLIER") as StoredHistoryMessage[]),
          user("Question."),
          answer("Reply."),
          user("Now."),
        ],
        context("automatic", true).ctx,
      );

      expect(kept).toEqual([...checkpointHead("SUMMARY"), user("Now.")]);
    });

    it("ignores it for a manual compaction", async () => {
      const withHead = [...(checkpointHead("EARLIER") as StoredHistoryMessage[]), ...recent];

      expect(await compact(withHead, context("manual", true).ctx)).toEqual(
        await compact(withHead, context("manual", false).ctx),
      );
    });
  });

  it("budgets the summary request's fixed prompt in the trigger", () => {
    expect(COMPACTION_PROMPT_OVERHEAD_TOKENS).toBe(
      estimateTokens([
        { content: COMPACTION_PROMPT_ENVELOPE.system, role: "system" },
        createFrameworkUserMessage("context.compaction", COMPACTION_PROMPT_ENVELOPE.prompt),
      ]),
    );
  });
});
