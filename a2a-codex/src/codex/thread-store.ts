/**
 * Where Codex keeps its threads, and the thread options a turn runs with.
 *
 * A Codex thread is a "rollout" file on disk (`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<timestamp>-<thread id>.jsonl`), so it
 * outlives the wrapper process: the thread id is all a later process needs to resume the conversation.
 */

import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { AgentConfig } from "../config/types.js";
import type { ThreadOptionsLike } from "./client-factory.js";

/** The shape of a thread id (a UUID). Anything else is not a thread this wrapper bound, and `codex exec resume` would take it for a thread NAME or a prompt. */
const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isThreadId(value: string): boolean {
  return THREAD_ID.test(value);
}

/** The Codex home directory the CLI uses (`CODEX_HOME`, else `~/.codex`). */
export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME?.trim() || join(homedir(), ".codex");
}

/** The thread options of a turn, from the resolved config. Passed on resume too: they are per run, not stored with the thread. */
export function buildThreadOptions(config: Required<AgentConfig>): ThreadOptionsLike {
  const codex = config.codex;
  return {
    workingDirectory: codex.workingDirectory || undefined,
    model: codex.model || undefined,
    sandboxMode: codex.sandboxMode ?? "workspace-write",
    approvalPolicy: codex.approvalPolicy ?? "never",
    networkAccessEnabled: codex.networkAccessEnabled ?? false,
    webSearchMode: codex.webSearchMode ?? "disabled",
    skipGitRepoCheck: codex.skipGitRepoCheck ?? false,
    additionalDirectories:
      codex.additionalDirectories && codex.additionalDirectories.length > 0 ? codex.additionalDirectories : undefined,
  };
}

async function listNames(dir: string): Promise<string[] | undefined> {
  try {
    return (await readdir(dir)).sort().reverse(); // newest first: dates and years sort lexically
  } catch {
    return undefined;
  }
}

/**
 * Does the rollout of this thread exist on disk? `true`/`false` when the answer is certain, `undefined` when the sessions
 * directory cannot be read (a different `CODEX_HOME` than the CLI's, permissions): the caller must not conclude "gone".
 * Newest days first, stops at the first hit.
 */
export async function threadExistsOnDisk(threadId: string, home: string = codexHome()): Promise<boolean | undefined> {
  if (!isThreadId(threadId)) return false;
  const root = join(home, "sessions");
  const years = await listNames(root);
  if (!years) return undefined;
  const suffix = `-${threadId.toLowerCase()}.jsonl`;
  for (const year of years) {
    for (const month of (await listNames(join(root, year))) ?? []) {
      for (const day of (await listNames(join(root, year, month))) ?? []) {
        const files = await listNames(join(root, year, month, day));
        if (files?.some((f) => f.toLowerCase().endsWith(suffix))) return true;
      }
    }
  }
  return false;
}

/** Does this failure say Codex has no such thread? (`codex exec resume <id>` exits 1: "thread/resume failed: no rollout found for thread id <id>".) */
export function isThreadNotFound(error: unknown): boolean {
  const msg = ((error as Error)?.message ?? String(error)).toLowerCase();
  return /no rollout found|no saved session|thread\/resume failed|(thread|session|rollout)[^.\n]{0,40}(not found|does not exist|no such)|no such (thread|session)/.test(msg);
}
