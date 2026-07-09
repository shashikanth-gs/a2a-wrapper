# a2a-antigravity

## 0.1.1

### Patch Changes

Initial release of `a2a-antigravity`, an A2A protocol wrapper for Google Antigravity.

This package exposes Antigravity as a standalone HTTP A2A agent while keeping the public wrapper in Node/TypeScript. The Google Antigravity SDK remains isolated behind a private Python subprocess and JSONL bridge.

**Features:**

- **A2A-compliant server** - Agent Card, JSON-RPC, REST, and health endpoints via `@a2a-js/sdk`.
- **Google Antigravity SDK integration** - backed by `google-antigravity==0.1.5` through a private Python bridge.
- **Managed Python setup** - `a2a-antigravity setup` creates a virtual environment, installs bundled requirements, and verifies `google.antigravity` imports.
- **Gemini and Vertex auth** - supports Gemini API key auth and Vertex/ADC project/location configuration.
- **Tested Flash-Lite model** - example configs use `gemini-3.1-flash-lite`.
- **Command policy examples** - default config keeps SDK command policy defaults; `config.run-command.json` demonstrates trusted-workspace `run_command` enablement.
- **Sideband trace artifacts** - lifecycle, tool-start, usage, error, and response artifacts are mapped into A2A trace artifacts.
- **MCP passthrough** - stdio and Streamable HTTP MCP server configs are translated into Antigravity SDK config.
- **Memory materialization** - memory files are written to `AGENTS.md` and `.antigravity/skills/` before session startup.
- **A2A sub-agent delegation** - sub-agents are exposed through the shared `a2a-mcp-skillmap` bridge.
- **Subprocess lifecycle hardening** - bridge spawn errors, unexpected exits, write failures, shutdown, and signal handling are surfaced cleanly instead of hanging requests.
- **CI coverage** - GitHub Actions verifies TypeScript build/test plus managed Python setup and package contents before publish.

**Operational notes:**

- The default A2A port is `3040`, intentionally offset from `a2a-claude` on `3030`.
- The npm package does not run `pip` during install. Run `a2a-antigravity setup` once before starting the server, or provide your own Python with `ANTIGRAVITY_PYTHON`.
- `run_command` is denied by the Antigravity SDK default policy unless explicitly allowed.
