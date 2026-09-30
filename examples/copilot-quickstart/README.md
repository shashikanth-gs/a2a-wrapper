# Copilot Quickstart: GitHub Copilot as an A2A server

The simplest useful thing you can do with `a2a-wrapper`: turn GitHub Copilot into an A2A server with one config file, then talk to it from any A2A client. When you're done, continue to the [Software Engineering Crew](../software-engineering-crew/) to see several agents work together.

![Recording: start a2a-copilot, discover it via its agent card, ask it a question](../../docs/assets/copilot-quickstart.gif)

*The recording is a real run against GitHub Copilot.*

## What you need

- Node >= 20
- A GitHub account with Copilot access, signed in with `gh auth login` (or set `GITHUB_TOKEN`)

## 1. Install and start the server

```bash
npm install -g a2a-copilot
gh auth login            # skip if you already have, or export GITHUB_TOKEN=...

# from this directory:
a2a-copilot --config config.json
```

Running from a source checkout instead? From the repo root run `npm install && npx turbo run build`, then `cd a2a-copilot && npm run dev -- --config ../examples/copilot-quickstart/config.json`.

[`config.json`](config.json) is the whole integration: an agent card (name, skills), a port, and a system prompt. It binds to `127.0.0.1`, so only your machine can reach it.

`"model": "auto"` lets Copilot choose a model your plan has access to. If you want a specific model and get `Model "..." is not available`, that model isn't enabled for your account; pick another or use `auto`.

## 2. Discover it

Every A2A agent publishes an agent card. Any client starts here:

```bash
curl -s localhost:3000/.well-known/agent-card.json | jq '{name, protocolVersion, url, skills: [.skills[].id]}'
```

## 3. Talk to it

With the tiny dependency-free client in this folder:

```bash
node ask.mjs "In two sentences, what does Array.prototype.flatMap do?"
```

Or with raw JSON-RPC, which is all `ask.mjs` does:

```bash
curl -s -X POST localhost:3000/a2a/jsonrpc -H 'content-type: application/json' -d '{
  "jsonrpc": "2.0", "id": "1", "method": "message/send",
  "params": { "message": { "kind": "message", "messageId": "m1", "role": "user",
    "parts": [{ "kind": "text", "text": "What does Array.prototype.flatMap do?" }] },
    "configuration": { "blocking": true } }
}'
```

Because this is standard A2A, the same server also works with the official A2A SDKs, inspectors and other orchestrators. Nothing here is specific to `ask.mjs`.

## Security

The endpoint has no built-in authentication, and Copilot can act on your machine depending on its tool permissions. Keep it on `127.0.0.1` (as this config does) and read the [Security Guide](../../docs/security.md) before exposing it.

## Next

- **Combine agents:** [Software Engineering Crew](../software-engineering-crew/): Claude Code implements, Codex writes the tests, all over A2A.
- **Use another backend:** the same pattern works for `a2a-claude`, `a2a-codex`, `a2a-opencode` and `a2a-antigravity`; only the config block changes.
- **Regenerate the recording:** `vhs docs/assets/copilot-quickstart.tape` from the repo root.
