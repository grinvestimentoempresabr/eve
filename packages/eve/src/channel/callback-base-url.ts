import { currentApp } from "#context/app.js";
import { resolveWorkflowCallbackBaseUrl } from "#execution/workflow-callback-url.js";
import type { Entities } from "#platform/entities.js";

export function resolveChannelCallbackBaseUrl(
  metadataUrl: string,
  platform: Entities = currentApp().platform,
): string {
  return resolveWorkflowCallbackBaseUrl(metadataUrl, platform);
}
