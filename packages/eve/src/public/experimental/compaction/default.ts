import type { ModelMessage } from "ai";

import type { PublicAgentStaticModelDefinition } from "#shared/agent-definition.js";
import type { CompactionStrategy } from "#shared/compaction-strategy.js";
import type { StoredHistoryMessage } from "#shared/history-message.js";

import { COMPACTION_PROMPT_OVERHEAD_TOKENS } from "./checkpoint-prompt.js";
import {
  type CompactionStage,
  compactMessages,
  extractPreviousCheckpoint,
} from "./default-engine.js";

const RECENT_WINDOW_SIZE = 10;

function thresholdClearingTrigger(threshold: number): number {
  return Math.max(1, threshold - COMPACTION_PROMPT_OVERHEAD_TOKENS);
}

const isDue = ({ inputTokens, threshold }: { inputTokens: number; threshold: number }) =>
  inputTokens + COMPACTION_PROMPT_OVERHEAD_TOKENS > threshold;

/** What `defaultCompaction()` can change: the model that writes its summary, and the instructions added to the checkpoint prompt. */
export interface DefaultCompactionOptions {
  /** The model that writes the summary, when it isn't the turn's model. */
  readonly model?: PublicAgentStaticModelDefinition;
  /** Added to eve's checkpoint prompt, such as what the summary must keep word for word. */
  readonly instructions?: string;
}

/**
 * eve's compaction when you configure none. It caps oversized tool results in older history, with
 * no model call, and summarizes the older history if capping doesn't fit. When a rewrite doesn't
 * hold for one response (`ctx.recompacting`), the next one drops the kept tool turns, then the
 * whole kept tail. A manual compaction goes straight to summarizing. It runs before a model
 * request and before its retry.
 *
 * ```ts
 * experimental: {
 *   compaction: defaultCompaction({
 *     model: "openai/gpt-5-mini",
 *     instructions: "Keep every ticket ID exactly as written.",
 *   }),
 * },
 * ```
 */
export function defaultCompaction(options: DefaultCompactionOptions = {}): CompactionStrategy {
  return {
    when: { "model.requested": isDue, "model.retried": isDue },
    compact: async (history, ctx) => {
      const { messages } = await compactMessages(
        history as ModelMessage[],
        {
          estimate: (messages) => ctx.tokens.estimate(messages as StoredHistoryMessage[]),
          lastStage:
            ctx.recompacting && ctx.reason !== "manual"
              ? stageOfPreviousResult(history)
              : undefined,
          recentWindowSize: RECENT_WINDOW_SIZE,
          target: ctx.tokens.target,
          threshold: thresholdClearingTrigger(ctx.tokens.threshold),
        },
        async (prompt) => {
          const { text } = await ctx.call({
            messages: prompt.messages as StoredHistoryMessage[],
            model: options.model,
            system:
              options.instructions === undefined
                ? prompt.system
                : `${prompt.system}\n\n${options.instructions}`,
          });
          if (text.trim().length === 0) {
            throw new Error("The compaction model returned an empty summary.");
          }
          return text;
        },
        ctx.reason === "manual",
        ctx.reason !== "manual",
      );
      return messages as StoredHistoryMessage[];
    },
  };
}

function stageOfPreviousResult(
  history: readonly StoredHistoryMessage[],
): CompactionStage | undefined {
  const { conversation, previousCheckpoint } = extractPreviousCheckpoint(history as ModelMessage[]);
  if (previousCheckpoint === undefined) return undefined;
  return conversation.some((message) => message.role === "tool") ? "tail" : "text-tail";
}
