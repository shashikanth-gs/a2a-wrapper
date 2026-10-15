---
"a2a-codex": patch
---

Fix `subAgents` startup failure ("MCP server key "a2a-subagents" is reserved") by validating only user-supplied MCP servers before the internal bridge entry is merged. Add `defaultToolsApprovalMode` / `toolApprovalModes` to MCP server config (mapped to Codex `default_tools_approval_mode` and `tools.<name>.approval_mode`) so MCP tools can be pre-approved in headless mode with `approvalPolicy: "never"`; the sub-agent bridge is pre-approved automatically.
