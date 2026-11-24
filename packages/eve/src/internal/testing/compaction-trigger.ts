import type { ModelMessage } from "ai";

import { getInputTokenCount } from "#harness/compaction/engine.js";
import type { CompactionConfig } from "#harness/types.js";
import { defaultCompaction } from "#public/experimental/compaction/default.js";

const trigger = (() => {
  const { when } = defaultCompaction() as {
    readonly when: { readonly "model.requested": (measure: Measure) => boolean };
  };
  return when["model.requested"];
})();

interface Measure {
  readonly inputTokens: number;
  readonly threshold: number;
}

export function shouldCompact(
  messages: readonly ModelMessage[],
  config: CompactionConfig,
  requestEnvelopeTokens = 0,
  previousEnvelopeTokens = 0,
): boolean {
  return (
    messages.length > 0 &&
    trigger({
      inputTokens: getInputTokenCount(
        messages,
        config,
        requestEnvelopeTokens,
        previousEnvelopeTokens,
      ),
      threshold: config.threshold,
    })
  );
}
