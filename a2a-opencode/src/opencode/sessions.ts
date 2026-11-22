/**
 * Permission rulesets applied to the OpenCode sessions this wrapper creates.
 *
 * With the default policy (`features.autoApprovePermissions`, on) every tool the wrapper knows is allowed up front, as it always was,
 * so nothing asks. When the interaction policy is `ask`, the rules that would have allowed a tool with side effects ask instead
 * (reading stays allowed): OpenCode then raises `permission.asked` and the A2A client decides.
 */

import type { PermissionRuleset } from "./types.js";

export const AUTO_ALLOW_PERMISSIONS: PermissionRuleset = [
  { permission: "read",  pattern: "*", action: "allow" },
  { permission: "edit",  pattern: "*", action: "allow" },
  { permission: "bash",  pattern: "*", action: "allow" },
  { permission: "glob",  pattern: "*", action: "allow" },
  { permission: "grep",  pattern: "*", action: "allow" },
  { permission: "list",  pattern: "*", action: "allow" },
  { permission: "task",  pattern: "*", action: "allow" },
  { permission: "mcp",   pattern: "*", action: "allow" },
  { permission: "fetch", pattern: "*", action: "allow" },
];

/** The same list under `interactions.mode: "ask"`: reads are allowed, everything with a side effect asks. */
export const ASK_PERMISSIONS: PermissionRuleset = AUTO_ALLOW_PERMISSIONS.map((r) =>
  ["read", "glob", "grep", "list"].includes(r.permission) ? r : { ...r, action: "ask" as const },
);

/** The ruleset for a new session: none (the server's own) when nothing should be decided up front. */
export function sessionPermissions(opts: { ask: boolean; autoApprove: boolean }): PermissionRuleset | undefined {
  if (opts.ask) return ASK_PERMISSIONS;
  return opts.autoApprove ? AUTO_ALLOW_PERMISSIONS : undefined;
}
