---
"a2a-claude": patch
---

Send configured MCP servers to the Claude CLI through the initialize request (`mcpServersDelivery: "initialize"`) instead of the deprecated command-line argument. A custom `executablePathOverride` explicitly stays on `argv`, since an older binary may not support `initialize`.
