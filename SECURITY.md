# Security Policy

## Supported Versions

The following packages are actively maintained and receive security updates:

| Package | Supported Versions |
| --- | --- |
| `@a2a-wrapper/core` | Latest |
| `a2a-copilot` | Latest |
| `a2a-opencode` | Latest |

Only the latest published version of each package is supported with security patches.

## Reporting a Vulnerability

If you discover a security vulnerability in any package within this monorepo, please report it responsibly through [GitHub Security Advisories](https://github.com/shashikanth-gs/a2a-wrapper/security/advisories/new).

**Please do not open a public issue for security vulnerabilities.**

When reporting, include:

- Which package is affected (`@a2a-wrapper/core`, `a2a-copilot`, or `a2a-opencode`)
- A description of the vulnerability
- Steps to reproduce the issue
- Any potential impact

## Security Update Process

1. Reported vulnerabilities are triaged and confirmed privately via GitHub Security Advisories.
2. A fix is developed and reviewed in a private fork.
3. A security patch is released for the affected package(s) using [Changesets](https://github.com/changesets/changesets).
4. An advisory is published on the [repository security page](https://github.com/shashikanth-gs/a2a-wrapper/security/advisories).

## Scope

This policy covers all workspace packages in the [a2a-wrapper monorepo](https://github.com/shashikanth-gs/a2a-wrapper):

- **`@a2a-wrapper/core`** (`packages/core/`) — shared A2A protocol core library
- **`a2a-copilot`** (`a2a-copilot/`) — A2A wrapper for Copilot
- **`a2a-opencode`** (`a2a-opencode/`) — A2A wrapper for OpenCode
