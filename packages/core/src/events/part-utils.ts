/**
 * @module events/part-utils
 *
 * Helpers for reading inbound A2A {@link Part} content. Centralises the
 * v1.0 `Part.content.$case` discrimination so wrapper projects never need
 * to hand-roll it against raw SDK types.
 */

import type { Message } from "@a2a-js/sdk";
import type { CorePart } from "../model/primitives.js";

/**
 * Extracts and joins all text parts from a {@link Message}, in order.
 *
 * Non-text parts (`raw`, `url`, `data`, or an absent `content`) are
 * ignored. Multiple text parts are joined with newlines.
 *
 * @param message - The inbound A2A message to read.
 * @returns The concatenated text content, or `""` if the message has no
 *   text parts.
 *
 * @example
 * ```ts
 * const text = extractUserText(requestContext.userMessage);
 * ```
 */
export function extractUserText(message: Message): string {
  return message.parts
    .map((part) => (part.content?.$case === "text" ? part.content.value : undefined))
    .filter((text): text is string => text !== undefined)
    .join("\n");
}

/**
 * {@link extractUserText} for core parts: the text parts of a provider request's input, joined with newlines.
 * Other parts (data, files, unmodelled) are ignored.
 */
export function corePartsText(parts: readonly CorePart[]): string {
  return parts
    .map((part) => (part.kind === "text" ? part.text : undefined))
    .filter((text): text is string => text !== undefined)
    .join("\n");
}
