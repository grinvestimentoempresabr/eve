import type { HistoryMessageKind, StoredHistoryMessage } from "#shared/history-message.js";

const INJECTED_KINDS: ReadonlySet<HistoryMessageKind> = new Set([
  "memory.load",
  "context.instruction",
  "context.state",
  "context.compaction",
  "execution.retry",
]);

/**
 * The history without the messages eve adds fresh to every request: recalled memory, injected
 * context and state, a compaction summary or prompt, and retry notes. A provider that folds the
 * request into a record it keeps would hold a stale copy of them.
 */
export function withoutInjected(history: readonly StoredHistoryMessage[]): StoredHistoryMessage[] {
  return history.filter((message) => message.role !== "user" || !INJECTED_KINDS.has(message.kind));
}
