import { defaultCompaction } from "./default.js";
import { withoutInjected } from "./injected.js";
import { createLogger, logError } from "#internal/logging.js";
import type { CompactionRewrite, CompactionStrategy } from "#shared/compaction-strategy.js";
import type { StoredHistoryMessage } from "#shared/history-message.js";

const log = createLogger("harness.compaction");

const OPENAI_RESPONSES_PROVIDER = "openai.responses";

/** What `openaiCompaction()` can change: the strategy it falls back to. */
export interface OpenAICompactionOptions {
  /** Compacts when OpenAI's compaction can't: another provider's model, or a failed call. Defaults to `defaultCompaction()`. */
  readonly fallback?: CompactionStrategy;
}

/**
 * Compacts with OpenAI's own compaction instead of a text summary. eve sends the turn's request
 * with OpenAI's `compaction_trigger`, and OpenAI answers with an encrypted record of what the
 * history held. eve stores that record as the history and sends it back with every later request,
 * so the model keeps its working state where a summary would drop it.
 *
 * It needs the OpenAI Responses API called directly, with `openai("gpt-...")`. On any other model,
 * and when the call fails, the compaction falls back to `fallback`, which defaults to
 * `defaultCompaction()`, and logs why. The record is unreadable to other providers: a session
 * that switches models after a native compaction logs a warning on each request.
 *
 * ```ts
 * experimental: { compaction: openaiCompaction() },
 * ```
 */
export function openaiCompaction(options: OpenAICompactionOptions = {}): CompactionStrategy {
  const fallback = rewriteOf(options.fallback ?? defaultCompaction());
  return async (history, ctx) => {
    if (ctx.model.provider !== OPENAI_RESPONSES_PROVIDER) {
      log.warn(
        `openaiCompaction() needs the OpenAI Responses API called directly; the model is ${ctx.model.provider} ${ctx.model.modelId}, so eve compacts with its fallback instead.`,
        { sessionId: ctx.session.id },
      );
      return await fallback(history, ctx);
    }
    const sendable = withoutInjected(history);
    if (endsWithCompaction(sendable)) return undefined;
    try {
      const { messages } = await ctx.call({
        messages: sendable,
        providerOptions: { openai: { compactionTrigger: true } },
        tools: "inherit",
      });
      return messages;
    } catch (error) {
      if (ctx.abortSignal.aborted) throw error;
      logError(log, "OpenAI compaction failed; eve compacts with its fallback instead", error, {
        sessionId: ctx.session.id,
      });
      return await fallback(history, ctx);
    }
  };
}

function rewriteOf(strategy: CompactionStrategy): CompactionRewrite {
  return typeof strategy === "function" ? strategy : strategy.compact;
}

function endsWithCompaction(history: readonly StoredHistoryMessage[]): boolean {
  const last = history.at(-1);
  return (
    last?.role === "assistant" &&
    Array.isArray(last.content) &&
    last.content.some(
      (part) => part.type === "custom" && (part as { kind?: unknown }).kind === "openai.compaction",
    )
  );
}
