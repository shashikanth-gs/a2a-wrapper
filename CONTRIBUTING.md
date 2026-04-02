# Contributing to a2a-wrapper

Thanks for your interest in contributing! This is a monorepo containing multiple packages — this guide covers how to work across all of them.

## Prerequisites

- [Node.js](https://nodejs.org/) >= 18.0.0
- npm (comes with Node.js)

## Repository Structure

```
a2a-wrapper/
├── packages/
│   └── core/              # @a2a-wrapper/core — shared infrastructure
├── a2a-copilot/           # a2a-copilot — GitHub Copilot SDK wrapper
├── a2a-opencode/          # a2a-opencode — OpenCode wrapper
├── turbo.json             # Turborepo task pipeline
├── .changeset/            # Changesets versioning config
└── package.json           # Root workspace config
```

- `packages/core/` — shared library (`@a2a-wrapper/core`): logging, config loading, event publishing, server factory, session management, CLI scaffold
- `a2a-copilot/` — A2A wrapper for GitHub Copilot SDK
- `a2a-opencode/` — A2A wrapper for OpenCode

All packages are managed via [npm workspaces](https://docs.npmjs.com/cli/using-npm/workspaces) and built with [Turborepo](https://turbo.build/).

## Getting Started

```bash
# Clone the repository
git clone https://github.com/shashikanth-gs/a2a-wrapper.git
cd a2a-wrapper

# Install dependencies for all packages (from the repo root)
npm install
```

A single `npm install` at the root resolves dependencies for every package and hoists shared ones.

## Development Commands

All commands run from the repository root using Turborepo:

```bash
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

## Working on a Specific Package

You can scope Turborepo to a single package with `--filter`:

```bash
# Build only core
npx turbo run build --filter=@a2a-wrapper/core

# Test only a2a-copilot
npx turbo run test --filter=a2a-copilot

# Build a2a-opencode and its dependencies
npx turbo run build --filter=a2a-opencode...
```

Or work directly inside a package directory:

```bash
cd packages/core
npm test

cd a2a-copilot
npm test
```

## Creating Changesets

This project uses [Changesets](https://github.com/changesets/changesets) for versioning and changelogs. Every PR that changes package behavior should include a changeset.

```bash
# Create a new changeset (interactive prompt)
npx changeset
```

The CLI will ask you:
1. Which packages were affected
2. The semver bump type (patch / minor / major)
3. A summary of the change

This creates a markdown file in `.changeset/` — commit it with your PR. When the PR merges, the Changesets GitHub Action opens a "Version Packages" PR that batches pending bumps. Merging that PR publishes the updated packages to npm.

### When to create a changeset

- Bug fixes → `patch`
- New features (backward-compatible) → `minor`
- Breaking changes → `major`
- Documentation-only or CI-only changes → no changeset needed

## Adding a New Wrapper

Adding a new A2A wrapper (e.g. `a2a-claude`) requires no changes to the root config or core package:

1. Create a directory at the repo root following the `a2a-<name>` naming convention:
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

2. In `package.json`, set:
   - `name` to `a2a-<name>`
   - `@a2a-wrapper/core` as a dependency (`"*"`)
   - `publishConfig.access` to `"public"`
   - A `build`, `test`, and `typecheck` script

3. Implement the `A2AExecutor` interface from `@a2a-wrapper/core` and wire it up with `createCli()`.

4. Run `npm install` at the repo root to link the new package.

5. Verify everything works:
   ```bash
   npx turbo run build test typecheck
   ```

6. Create a changeset for the initial release:
   ```bash
   npx changeset
   ```

The `a2a-*` workspace glob in the root `package.json` automatically picks up the new directory — no config edits needed.

## Pull Request Process

1. Fork the repo and create a feature branch from `main`.
2. Make your changes and add tests where appropriate.
3. Run the full build and test suite:
   ```bash
   npx turbo run build typecheck test
   ```
4. Create a changeset if your change affects published packages:
   ```bash
   npx changeset
   ```
5. Open a pull request against `main`. CI will build and test across Node.js 18, 20, and 22.
6. Address review feedback and ensure CI passes.

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). Please read it before participating.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
