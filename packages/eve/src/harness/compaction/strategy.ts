import type { SystemModelMessage, ToolSet } from "ai";

import type { HarnessModelMessage } from "#harness/messages.js";
import { estimateTokens } from "#harness/token-estimate.js";
import type {
  CompactionCallRequest,
  CompactionCallResult,
  CompactionContext,
  CompactionEvent,
  CompactionStrategy,
  ResolvedCompactionStrategy,
} from "#shared/compaction-strategy.js";
import type { StoredHistoryMessage } from "#shared/history-message.js";

export function resolveStrategy(strategy: CompactionStrategy): ResolvedCompactionStrategy {
  if (typeof strategy === "function") {
    return { compact: strategy, when: { "model.requested": true } };
  }
  return { compact: strategy.compact, when: strategy.when ?? { "model.requested": true } };
}

export function triggersAt(
  strategy: ResolvedCompactionStrategy,
  event: CompactionEvent | undefined,
): boolean {
  return event !== undefined && strategy.when[event] !== undefined;
}

export type RequestInstructions = string | SystemModelMessage | SystemModelMessage[] | undefined;

export interface RequestPrefix {
  readonly instructions: RequestInstructions;
  readonly tools?: ToolSet;
}

export interface StrategyRun {
  readonly abortSignal: AbortSignal;
  readonly event: CompactionContext["event"];
  readonly model: Pick<CompactionContext["model"], "contextWindowTokens" | "maxOutputTokens">;
  readonly reason: CompactionContext["reason"];
  readonly recompacting: boolean;
  readonly sessionId: string;
  readonly threshold: number;
  call(request: CompactionCallRequest): Promise<CompactionCallResult>;
  identity(): Promise<Pick<CompactionContext["model"], "provider" | "modelId">>;
  tokens(): {
    readonly limit: number;
    fit(): Pick<CompactionContext["tokens"], "target" | "threshold">;
  };
}

export function strategyHistory(
  strategy: ResolvedCompactionStrategy,
  run: StrategyRun,
): (input: {
  readonly history: readonly HarnessModelMessage[];
  readonly inputTokens: number;
}) => Promise<readonly HarnessModelMessage[] | undefined> {
  return async ({ history, inputTokens }) => {
    if (run.reason === "automatic") {
      const trigger = run.event === undefined ? undefined : strategy.when[run.event];
      if (trigger === undefined) return undefined;
      const isDue =
        trigger === true
          ? inputTokens > run.threshold
          : trigger({
              contextWindowTokens: run.model.contextWindowTokens,
              maxOutputTokens: run.model.maxOutputTokens,
              inputTokens,
              threshold: run.threshold,
            });
      if (!isDue) return undefined;
    }
    const tokens = run.tokens();
    const ctx: CompactionContext = {
      abortSignal: run.abortSignal,
      call: (request) => run.call(request),
      event: run.event,
      model: { ...run.model, ...(await run.identity()) },
      reason: run.reason,
      recompacting: run.recompacting,
      session: { id: run.sessionId },
      tokens: {
        limit: tokens.limit,
        get target() {
          return tokens.fit().target;
        },
        get threshold() {
          return tokens.fit().threshold;
        },
        estimate: (messages: readonly StoredHistoryMessage[]) =>
          estimateTokens(messages as HarnessModelMessage[]),
      },
    };
    return (await strategy.compact(history as StoredHistoryMessage[], ctx)) as
      | readonly HarnessModelMessage[]
      | undefined;
  };
}
