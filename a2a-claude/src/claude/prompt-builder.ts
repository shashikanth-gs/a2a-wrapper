/**
 * Prompt Builder
 *
 * Extracts the user text from an A2A RequestContext message.
 * Joins all text parts with newlines.
 */

import type { Message as A2AMessage } from "@a2a-js/sdk";

export function extractUserText(message: A2AMessage): string {
  return message.parts
    .filter((p) => {
      const part = p as unknown as Record<string, unknown>;
      return part.kind === "text" || "text" in part;
    })
    .map((p) => (p as unknown as { text: string }).text)
    .join("\n");
}
