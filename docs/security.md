# Security Guide

An `a2a-*` wrapper turns a coding agent — one that can read files, edit files and often run shell commands — into an HTTP service. Treat it like exposing a shell, not like exposing a chatbot. This page describes what the wrappers do and do not protect you from, so you can deploy them safely.

> Found a vulnerability? Please report it privately — see [SECURITY.md](../SECURITY.md).

## The short version

1. **The A2A endpoint has no built-in authentication.** The server is built with `UserBuilder.noAuthentication` (see `packages/core/src/server/factory.ts`). Anyone who can reach the port can send the agent tasks.
2. **The default bind address is `0.0.0.0`** (all interfaces). Change it unless you mean to expose the agent.
3. **Put the agent in a workspace you can afford to lose** — a scratch clone, a container, or a VM — and keep secrets out of it.
4. **Use the narrowest permission / sandbox mode that still does the job.**

## 1. Network exposure

| Situation | Do this |
|---|---|
| Local development, agents only talk to each other on one machine | Set `"server": { "hostname": "127.0.0.1" }` in the agent config |
| Agents on different hosts | Keep the agent on a private network and put a reverse proxy in front that enforces authentication (bearer token, mTLS, or your SSO) and TLS |
| Public internet | Don't expose the agent directly. If you must, authenticate at a gateway first |

`server.hostname` controls the bind address. `server.advertiseHost` / `advertiseProtocol` only change the URLs written into the agent card; they do not restrict who can connect.

Outbound calls are a separate matter: when a wrapper calls *another* A2A agent (sub-agents), you can attach headers such as `Authorization: Bearer ${TOKEN}` from the environment. Keep tokens in environment variables, not in config files.

## 2. What the agent is allowed to do

Each wrapper has its own guardrails. They limit what the *backend* may do inside the workspace; they are not a substitute for network controls.

| Wrapper | Control | Safe choice | Dangerous choice |
|---|---|---|---|
| `a2a-claude` | `claude.permissionMode` | `plan` (read-only), or the default `acceptEdits` | `bypassPermissions` (needs `dangerouslyAllowBypassPermissions: true`; logs a warning at startup). `default` and `auto` are rejected because headless runs can't prompt a human |
| `a2a-codex` | `codex.sandboxMode` | `read-only`, or `workspace-write` with `networkAccessEnabled: false` | `danger-full-access` |
| `a2a-copilot` | Backend tool permissions | Run in a container with a scratch workspace | Mounting your home directory or real credentials |
| `a2a-opencode` | `--auto-approve` / `AUTO_APPROVE` (**on by default**) | `--no-auto-approve` where a human can approve, otherwise a container with a scratch workspace | Leaving auto-approve on with a real workspace and a network-reachable port |
| `a2a-antigravity` | `policies` (see "Command Policy and `run_command`" in its README) | Keep `run_command` disabled unless the workspace is trusted | Enabling `run_command` on untrusted input |

See each package README for the exact options.

## 3. Workspace and secrets hygiene

- **Point `WORKSPACE_DIR` at a dedicated checkout**, not at `~` and not at a repo holding production credentials.
- **Never store credentials in config files.** Use `${ENV_VAR}` placeholders, as the shipped examples do.
- **Assume prompt injection.** An agent reading untrusted files, web pages or issue text can be steered by that content. Combined with shell access, this is the main real-world risk. Don't point an agent with write access at untrusted input and then let it touch anything valuable.
- **Keep your own API keys private.** Anyone who can reach an unauthenticated agent spends your model quota.
- **Prefer containers.** Most wrappers ship a Dockerfile; run them with a read-only root filesystem where possible and mount only the workspace.

## 4. Multi-agent setups

In a planner → implementer → tester chain, each agent is another entry point. Give every agent its own workspace or branch, bind them all to loopback or a private network, and remember that an injected instruction in one agent's output becomes input to the next.

## Checklist before you expose an agent

- [ ] Bound to `127.0.0.1` or behind an authenticating proxy
- [ ] Runs in a container or disposable workspace
- [ ] Narrowest permission / sandbox mode that works
- [ ] No secrets in the workspace or config files
- [ ] Model-provider key has a spending limit
