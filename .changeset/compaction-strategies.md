---
"eve": minor
---

Set `experimental.compaction` in `agent.ts` to rewrite the history your own way when eve compacts, and choose when it runs.

The API is experimental and can change in a minor release.

`eve/experimental/compaction` exports `defaultCompaction()`, eve's own compaction written on the same context, and `withoutInjected()`. A strategy calls a model with one `ctx.call()`, which replaces separate summary and request calls, and returns the history to keep. Pass `{ compact, when }` to run it before a model call, at the end of a turn, or both, with a `when` map keyed by session event, each entry `true` or a function of the measure. eve checks every result before it applies it, the default's included, and never falls back to its default.

With `experimental.compaction` set, a model call the provider rejects as too long compacts with reason `overflow` and retries once, `ctx.recompacting` tells a strategy its last rewrite did not leave room, and `ctx.call()` rejects with `CompactionOverflowError` when its request is too long. Agents without it behave as before. `compaction.model` set together with `experimental.compaction` is an error: pass the model as `defaultCompaction({ model })`.

History messages are typed `StoredHistoryMessage`, with `kind` on every user message. A strategy can place its summary anywhere as a `context.compaction` message, and read `ctx.model` and `measure.maxOutputTokens`. An automatic result no longer has to keep the turn's latest user message.
