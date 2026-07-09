# a2a-wrapper

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js >=18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)

A monorepo of [A2A protocol](https://github.com/google-deepmind/a2a) wrappers that turn production AI backends into standalone, interoperable agents. Drop a JSON config file in, get a fully spec-compliant A2A server out.

> **The pattern:** MCP is the vertical rail — how agents access tools. A2A is the horizontal rail — how agents talk to each other. This repo adds the horizontal rail to multiple AI backends.

## Packages

| Package | npm | Description |
|---|---|---|
| [`@a2a-wrapper/core`](packages/core/) | [![npm](https://img.shields.io/npm/v/@a2a-wrapper/core.svg)](https://www.npmjs.com/package/@a2a-wrapper/core) | Shared infrastructure — logging, config loading, event publishing, server factory, session management, CLI scaffold |
| [`a2a-copilot`](a2a-copilot/) | [![npm](https://img.shields.io/npm/v/a2a-copilot.svg)](https://www.npmjs.com/package/a2a-copilot) | A2A wrapper for GitHub Copilot SDK. Supports **Bring Your Own Model (BYOK)** — Ollama, OpenAI, Anthropic, Azure, vLLM, or any OpenAI-compatible endpoint |
| [`a2a-opencode`](a2a-opencode/) | [![npm](https://img.shields.io/npm/v/a2a-opencode.svg)](https://www.npmjs.com/package/a2a-opencode) | A2A wrapper for OpenCode — multi-provider out of the box (Anthropic, OpenAI, GitHub Copilot, and more) |
| [`a2a-claude`](a2a-claude/) | [![npm](https://img.shields.io/npm/v/a2a-claude.svg)](https://www.npmjs.com/package/a2a-claude) | A2A wrapper for Claude Code — fully spec-compliant agent powered by the official `@anthropic-ai/claude-agent-sdk` |
| [`a2a-codex`](a2a-codex/) | [![npm](https://img.shields.io/npm/v/a2a-codex.svg)](https://www.npmjs.com/package/a2a-codex) | A2A wrapper for OpenAI Codex SDK — repository-scoped software engineering agent with sandboxing, MCP, and multi-agent delegation |
| [`a2a-antigravity`](a2a-antigravity/) | [![npm](https://img.shields.io/npm/v/a2a-antigravity.svg)](https://www.npmjs.com/package/a2a-antigravity) | A2A wrapper for Google Antigravity SDK — Node/TypeScript public server with a managed Python SDK subprocess, Gemini auth, policies, MCP, and sideband traces |

## Backend Flexibility

Several wrappers are provider-flexible — you are not locked into a single vendor:

- **`a2a-opencode`** is multi-provider out of the box. OpenCode natively routes to Anthropic, OpenAI, GitHub Copilot, local models, and more — switch provider with one line in `config.json`.
- **`a2a-copilot`** supports custom providers via GitHub Copilot's BYOK ("Bring Your Own Key") capability. Point it at a local Ollama instance, OpenAI, Anthropic, Azure OpenAI, Azure AI Foundry, vLLM, or any OpenAI-compatible endpoint using the `copilot.provider` config block. See the [a2a-copilot BYOK section](a2a-copilot/README.md#bring-your-own-model-byok) for setup and model requirements.
- **`a2a-antigravity`** exposes Google Antigravity through A2A while keeping the public package Node-based. It creates a managed Python environment for `google-antigravity` via `a2a-antigravity setup`, then uses Gemini API key or Vertex/ADC auth.

> **Note on local models (a2a-copilot):** the agentic loop requires the model to support **native tool calling**. Some small/older local models emit tool calls as plain text and won't work. Use a tool-capable model (e.g. `qwen3.6`, `llama3.3`). Full details in the [BYOK section](a2a-copilot/README.md#bring-your-own-model-byok).

## Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│                          @a2a-wrapper/core                             │
│      Logger · Config · Events · Server · Session · CLI                 │
│      Sub-Agents · Memory · Schema                                      │
└──────────────────────────────┬─────────────────────────────────────────┘
                               │
                               ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Wrapper packages                                                       │
│  • a2a-copilot      → GitHub Copilot SDK                               │
│  • a2a-opencode     → OpenCode Server                                  │
│  • a2a-claude       → Claude Code SDK                                  │
│  • a2a-codex        → OpenAI Codex SDK                                 │
│  • a2a-antigravity  → Google Antigravity SDK via Python bridge         │
└────────────────────────────────────────────────────────────────────────┘
```

Each wrapper implements a single `A2AExecutor` interface and a thin config/CLI layer. Everything else — A2A protocol compliance, Express server wiring, agent card building, session TTL management — comes from `@a2a-wrapper/core`.

## Calling Other A2A Agents (Sub-Agents)

Any parent agent can delegate to other A2A agents by declaring them under `subAgents` in its `config.json`. The wrapper spawns [`a2a-mcp-skillmap`](https://www.npmjs.com/package/a2a-mcp-skillmap) as a stdio MCP server and registers it under the reserved `a2a-subagents` key. Each remote skill becomes a callable MCP tool — the LLM dispatches to them like any other tool.

> **Bridge:** [`a2a-mcp-skillmap`](https://github.com/shashikanth-gs/a2a-mcp-skillmap) — the open-source bridge that fetches A2A agent cards, projects each skill as an MCP tool, and serves them over stdio or HTTP. See that repo for the full bridge documentation, config schema reference, response modes, session continuity, and OpenTelemetry integration.

```json
{
  "subAgents": {
    "agents": [
      {
        "name": "coding",
        "agentCardUrl": "https://coding.example.com/.well-known/agent-card.json",
        "auth": { "mode": "bearer", "token": "${CODING_AGENT_TOKEN}" }
      },
      {
        "name": "research",
        "agentCardUrl": "https://research.example.com/",
        "endpointUrlOverride": "https://research.internal.local/.well-known/agent-card.json"
      }
    ],
    "options": {
      "responseMode": "artifact",
      "probeTimeoutMs": 5000,
      "syncBudgetMs": 30000
    }
  }
}
```

The LLM sees `coding__<skillId>` and `research__<skillId>` tools. When `subAgents` is absent the parent starts normally with no side effects.

**Try it:** [`examples/a2a-subagents-scenario/`](examples/a2a-subagents-scenario/) — a self-contained runnable example with two fake sub-agents, a parent config, and a 26-assertion end-to-end test. No API keys required.

```bash
cd examples/a2a-subagents-scenario
./start-all.sh
```

## Quick Start

```bash
# Clone the monorepo
git clone https://github.com/shashikanth-gs/a2a-wrapper.git
cd a2a-wrapper

# Install all dependencies
npm install

# Run a specific wrapper
cd a2a-copilot
npm run dev -- --config agents/example/config.json

# Or
cd a2a-opencode
npm run dev -- --config agents/example/config.json

# Or
export ANTHROPIC_API_KEY=sk-... WORKSPACE_DIR=/path/to/repo
cd a2a-claude
npm run dev -- --config agents/example/config.json

# Or
export OPENAI_API_KEY=sk-... WORKSPACE_DIR=/path/to/repo
cd a2a-codex
npm run dev -- --config agents/example/config.json

# Or
export GEMINI_API_KEY=... WORKSPACE_DIR=/path/to/repo
cd a2a-antigravity
npm run dev -- setup
npm run dev -- --config agents/example/config.json
```

## Development

This monorepo uses [npm workspaces](https://docs.npmjs.com/cli/using-npm/workspaces), [Turborepo](https://turbo.build/) for task orchestration, and [Changesets](https://github.com/changesets/changesets) for versioning.

```bash
# Install dependencies for all packages
npm install

# Build all packages (core builds first, then wrappers in parallel)
npx turbo run build

# Run tests across all packages
npx turbo run test

# Type-check all packages
npx turbo run typecheck

# Clean build artifacts
npx turbo run clean
```

Turborepo caches build outputs — unchanged packages are skipped on subsequent runs.

### Working on a Specific Package

You can scope Turborepo to a single package with `--filter`:

```bash
# Build only core
npx turbo run build --filter=@a2a-wrapper/core

# Test only a2a-copilot
npx turbo run test --filter=a2a-copilot

# Build a2a-opencode and its dependencies
npx turbo run build --filter=a2a-opencode...

# Test only a2a-antigravity
npx turbo run test --filter=a2a-antigravity
```

### Changesets Workflow

Every PR that changes package behavior should include a changeset:

```bash
# Create a new changeset (interactive prompt)
npx changeset
```

The CLI will ask which packages were affected, the semver bump type (patch / minor / major), and a summary. Commit the generated file with your PR. When the PR merges, the Changesets GitHub Action opens a "Version Packages" PR that batches pending bumps. Merging that PR publishes the updated packages to npm.

## Adding a New Wrapper

Adding a new A2A wrapper (e.g. `a2a-claude`) requires no changes to the root config or core package:

1. **Create the directory** at the repo root following the `a2a-<name>` naming convention:
   ```
   a2a-claude/
   ├── package.json
   ├── tsconfig.json
   ├── src/
   │   ├── index.ts
   │   ├── cli.ts
   │   └── claude/
   │       ├── executor.ts       # Implements A2AExecutor
   │       ├── session-manager.ts
   │       └── config/
   │           ├── types.ts      # Extends BaseAgentConfig
   │           └── defaults.ts
   └── agents/
       └── example/
           └── config.json
   ```

2. **Implement the `A2AExecutor` interface** from `@a2a-wrapper/core`. This is the only interface your wrapper needs — it handles task execution for your backend. Define your backend config type extending `BaseAgentConfig<YourBackend>` and set up config defaults.

3. **Wire it up with `createCli()`** from `@a2a-wrapper/core` to get a fully functional CLI with config loading, server startup, and agent card generation out of the box.

4. **Add sub-agents support** (optional, ~10 lines) — call `bootstrapSubAgents()` inside `executor.initialize()` and provide a `toXxxMcpEntry()` adapter that maps the canonical `SynthesizedMcpDescriptor` to your wrapper's MCP entry shape. See `a2a-copilot/src/copilot/executor.ts` for a reference implementation.

4. **Set up `package.json`** with:
   - `name` set to `a2a-<name>`
   - `@a2a-wrapper/core` as a dependency (`"*"`)
   - `publishConfig.access` set to `"public"`
   - `build`, `test`, and `typecheck` scripts

5. **Run `npm install`** at the repo root to link the new package. The `a2a-*` workspace glob in the root `package.json` automatically picks up the new directory.

6. **Verify everything works:**
   ```bash
   npx turbo run build test typecheck
   ```

7. **Create a changeset** for the initial release:
   ```bash
   npx changeset
   ```

See the [core package README](packages/core/README.md) for the full API guide.

## Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) first.

## License

[MIT](LICENSE) © Shashi Kanth
