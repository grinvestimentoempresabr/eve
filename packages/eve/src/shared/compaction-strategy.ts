import type { PublicAgentStaticModelDefinition } from "#shared/agent-definition.js";
import type { StoredHistoryMessage } from "#shared/history-message.js";

/**
 * Why eve compacts, named as the AI SDK names them. `automatic`: the strategy's trigger said the
 * history is due. `manual`: a client called `session.compact()`. `overflow`: the provider rejected
 * a step's request as longer than the model's context window; eve compacts, then retries the call
 * once.
 */
export type CompactionReason = "automatic" | "manual" | "overflow";

/**
 * The session event eve asks a strategy at. `model.requested`: once the turn's model is chosen,
 * before its call starts. `model.retried`: a failed attempt runs again in the same run, before the
 * retried call starts. `turn.settled`: after the turn's answer, before the turn settles, so a long
 * task isn't interrupted mid-turn. A manual compaction has no event and always runs the strategy.
 */
export type CompactionEvent = "model.requested" | "model.retried" | "turn.settled";

/** What a trigger reads to decide whether the history is due. */
export interface CompactionMeasure {
  /**
   * The next request's input tokens: the provider's count for the last request, plus eve's
   * estimate of what joined history since.
   */
  readonly inputTokens: number;
  /** The input tokens `compaction.threshold` allows. */
  readonly threshold: number;
  /** The model's context window, in tokens. Absent when eve doesn't know the model's window. */
  readonly contextWindowTokens?: number;
  /** The most tokens the model writes in one response, from AI Gateway's model catalog. Absent when the catalog doesn't say. */
  readonly maxOutputTokens?: number;
}

/**
 * When a strategy runs, keyed by the session event eve asks at. An entry is `true` to run when
 * the next request would pass the threshold, or a function that decides from the measure. A
 * strategy without `when` runs at `model.requested` over the threshold. An overflow compaction
 * runs after `model.retried` whatever `when` lists.
 */
export type CompactionTrigger = {
  readonly [Event in CompactionEvent]?: true | ((measure: CompactionMeasure) => boolean);
};

/** A model call a strategy makes through `ctx.call()`. */
export interface CompactionCallRequest {
  /** Exactly what the model reads: eve adds no recalled memory, client context or announcements. */
  readonly messages: readonly StoredHistoryMessage[];
  /**
   * The model to call. Defaults to the turn's model, or to `compaction.model` when the agent
   * sets one for eve's default strategy.
   */
  readonly model?: PublicAgentStaticModelDefinition;
  /** The system prompt. Defaults to the turn's instructions. */
  readonly system?: string;
  /** `"inherit"` sends the turn's own tools, which the model can call but eve never runs. Defaults to `"none"`. */
  readonly tools?: "inherit" | "none";
  /** Provider options for this call, merged over the turn's. */
  readonly providerOptions?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

/** What `ctx.call()` returns: the assistant messages the model answered with, and their text. */
export interface CompactionCallResult {
  readonly messages: StoredHistoryMessage[];
  readonly text: string;
}

/** What a compaction strategy reads, and the one model call it makes. */
export interface CompactionContext {
  readonly reason: CompactionReason;
  /**
   * The event eve compacts at: the event the call last emitted, so `model.retried` for an
   * overflow compaction (it runs whatever `when` says, before the retried call), or `undefined`
   * for a manual one.
   */
  readonly event: CompactionEvent | undefined;
  readonly session: { readonly id: string };
  /**
   * The session model: the AI SDK's `provider` and `modelId` for it (`"openai.responses"` is
   * OpenAI's Responses API called directly, and a model routed through AI Gateway reports
   * `"gateway"`), and the limits the trigger's measure reports.
   */
  readonly model: Pick<CompactionMeasure, "contextWindowTokens" | "maxOutputTokens"> & {
    readonly provider: string;
    readonly modelId: string;
  };
  /**
   * `true` when the previous rewrite did not hold for one measured response: eve rewrote the
   * history, and after at most one model response the history is due again. A strategy with a
   * gentler and a harsher rewrite starts at the harsher one.
   */
  readonly recompacting: boolean;
  /**
   * Sizes in the units `estimate()` returns, eve's estimate of a message's tokens (a quarter of
   * its serialized bytes, plus media). They are not the provider's counts: the trigger's
   * `inputTokens` is the provider's count, and `target` is already divided by the measured ratio of
   * the provider's count to this estimate, so a history that `estimate()` puts at or under it fits
   * the target in the provider's tokens.
   */
  readonly tokens: {
    /**
     * The most history that fits the model's context window after instructions, tools, and
     * recall. Infinite when the window is unknown.
     */
    readonly limit: number;
    /** The history size `compaction.threshold` allows, after instructions, tools, and recall. */
    readonly threshold: number;
    /** The history size a compaction aims for, so the next request has room before it is due again. */
    readonly target: number;
    estimate(messages: readonly StoredHistoryMessage[]): number;
  };
  /**
   * Calls a model and returns what it answered. The call is the compaction's summary run, so eve
   * bills its usage there, and a request longer than the model's context window throws
   * `CompactionOverflowError`.
   */
  call(request: CompactionCallRequest): Promise<CompactionCallResult>;
  readonly abortSignal: AbortSignal;
}

/**
 * Rewrites an agent's stored history when eve compacts it, and returns the history to keep.
 * `undefined` keeps the history as it is. eve checks the result: every user message keeps a kind,
 * every call keeps its result, and an automatic result fits within `ctx.tokens.limit`. What the
 * model answers next is the strategy's: keep the turn's input, or carry it in the summary.
 */
export type CompactionRewrite = (
  history: readonly StoredHistoryMessage[],
  ctx: CompactionContext,
) =>
  | Promise<readonly StoredHistoryMessage[] | undefined>
  | readonly StoredHistoryMessage[]
  | undefined;

/** An agent's compaction strategy: a rewrite, or a rewrite with the trigger that runs it. */
export type CompactionStrategy =
  | CompactionRewrite
  | {
      readonly compact: CompactionRewrite;
      readonly when?: CompactionTrigger;
    };

export interface ResolvedCompactionStrategy {
  readonly compact: CompactionRewrite;
  readonly when: CompactionTrigger;
}

/**
 * A summary or provider request was longer than the model's context window. A strategy can catch
 * it from `ctx.call()`, drop part of what it sent, and call again.
 */
export class CompactionOverflowError extends Error {
  override readonly name = "CompactionOverflowError";

  constructor(options: { readonly cause: unknown }) {
    super("The compaction request is longer than the model's context window.", options);
  }
}
