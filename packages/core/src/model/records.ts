/**
 * @module model/records
 *
 * Persistence records for core's `TaskStore` extension. Types only: the stores
 * that read and write them come later.
 *
 * @see docs/design/core-data-model.md section 3.6
 */

import type { CoreInteraction, CoreInteractionResult } from "./interaction.js";
import type { SessionRef } from "./run.js";
import type { CoreTaskState } from "./primitives.js";

export interface PendingInteraction {
  interaction: CoreInteraction;
  taskId: string;
  contextId: string;
  runId: string;
  state: "pending" | "answered" | "expired" | "canceled";
  createdAt: string;
  expiresAt: string;
  /** Secret answers are stored redacted. */
  result?: CoreInteractionResult;
  /** Opaque provider handle, present only if the interaction can be re-attached. */
  handle?: string;
}

export interface ContextBinding {
  contextId: string;
  session?: SessionRef;
  updatedAt: string;
}

export interface RunRecord {
  runId: string;
  taskId: string;
  contextId: string;
  state: CoreTaskState;
  startedAt: string;
}
