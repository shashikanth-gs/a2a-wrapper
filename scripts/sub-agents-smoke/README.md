# Sub-Agents End-to-End Smoke Test

Validates the production sub-agents pipeline against the real
`a2a-mcp-skillmap` bridge. Used to satisfy task 12.3 of the
[a2a-subagents spec](../../.kiro/specs/a2a-subagents/tasks.md).

## What it covers

1. Spins up two fake A2A sub-agents on `:4101` and `:4102` that serve a
   minimal but realistic agent card with two skills each.
2. Runs `bootstrapSubAgents` from `@a2a-wrapper/core` — the same code
   path the parent executor uses.
3. Spawns the real `a2a-mcp-skillmap` bridge via `npx` with the
   generated config (the same descriptor the wrapper produces).
4. Speaks MCP over stdio: `initialize` handshake, then `tools/list`.
5. Asserts both sub-agents' skills are exposed as `<name>__<skill>`
   MCP tools.

## Run

```bash
# Terminal 1
node scripts/sub-agents-smoke/fake-sub-agent.mjs 4101 coding

# Terminal 2
node scripts/sub-agents-smoke/fake-sub-agent.mjs 4102 research

# Terminal 3
node scripts/sub-agents-smoke/run-bootstrap.mjs
```

Expected output: probe results show both agents reachable, the
bridge's `initialize` response identifies skillmap, and `tools/list`
returns at least one tool prefixed with `coding__` and `research__`
each. The harness exits 0 on success.

## Historical note

`a2a-mcp-skillmap@0.1.0` had an upstream entry-point guard bug that
prevented the CLI from running when launched via `npx` on macOS
(`/tmp -> /private/tmp` symlink resolution caused
`import.meta.url === \`file://${process.argv[1]}\`` to mismatch).
This is fixed in `0.2.0+`; the repository currently pins `0.2.1` in
[`packages/core/src/sub-agents/version.ts`](../../packages/core/src/sub-agents/version.ts).
