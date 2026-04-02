# a2a-wrapper

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js >=18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)

A monorepo of [A2A protocol](https://github.com/google-deepmind/a2a) wrappers that turn production AI backends into standalone, interoperable agents. Drop a JSON config file in, get a fully spec-compliant A2A server out.

> **The pattern:** MCP is the vertical rail — how agents access tools. A2A is the horizontal rail — how agents talk to each other. This repo adds the horizontal rail to multiple AI backends.

## Packages

| Package | npm | Description |
|---|---|---|
| [`@a2a-wrapper/core`](packages/core/) | [![npm](https://img.shields.io/npm/v/@a2a-wrapper/core.svg)](https://www.npmjs.com/package/@a2a-wrapper/core) | Shared infrastructure — logging, config loading, event publishing, server factory, session management, CLI scaffold |
| [`a2a-copilot`](a2a-copilot/) | [![npm](https://img.shields.io/npm/v/a2a-copilot.svg)](https://www.npmjs.com/package/a2a-copilot) | A2A wrapper for GitHub Copilot SDK |
| [`a2a-opencode`](a2a-opencode/) | [![npm](https://img.shields.io/npm/v/a2a-opencode.svg)](https://www.npmjs.com/package/a2a-opencode) | A2A wrapper for OpenCode (Anthropic, OpenAI, GitHub Copilot, and more) |

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                  @a2a-wrapper/core                   │
│  Logger · Config · Events · Server · Session · CLI  │
└──────────────┬──────────────────────┬───────────────┘
               │                      │
       ┌───────▼───────┐      ┌───────▼───────┐
       │  a2a-copilot  │      │ a2a-opencode  │
       │  (Copilot SDK)│      │  (OpenCode)   │
       └───────┬───────┘      └───────┬───────┘
               │                      │
         GitHub Copilot          OpenCode Server
```

Each wrapper implements a single `A2AExecutor` interface and a thin config/CLI layer. Everything else — A2A protocol compliance, Express server wiring, agent card building, session TTL management — comes from `@a2a-wrapper/core`.

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
