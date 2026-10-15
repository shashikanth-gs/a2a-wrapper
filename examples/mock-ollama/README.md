# Mock Ollama — shared local LLM stub

Lightweight **fake Ollama** for cookouts and feature tests. No GPU, no model
pull, no cloud keys.

Use it whenever you need Copilot or Claude (or any OpenAI-/Anthropic-compatible
client) to complete a real turn without talking to a vendor.

```
examples/mock-ollama/
  server.mjs          # HTTP stub (OpenAI + Anthropic APIs)
  smoke.mjs           # Start mock → run a2a-copilot + a2a-claude → message/send
  agents/
    copilot.json      # BYOK config for a2a-copilot
    claude.json       # config for a2a-claude (+ ANTHROPIC_BASE_URL)
  README.md
```

## What it speaks

| API | Path | Used by |
|---|---|---|
| OpenAI Chat Completions | `POST /v1/chat/completions` | generic OpenAI clients |
| OpenAI Responses | `POST /v1/responses` | Copilot CLI ↔ Ollama |
| Anthropic Messages | `POST /v1/messages` | Claude Code ↔ Ollama |
| Model list | `GET /v1/models`, `GET /api/tags` | discovery probes |

Default listen: `http://127.0.0.1:11434`  
Configurable reply via `MOCK_OLLAMA_REPLY` (default `pong-from-mock-ollama`).

## Quick start

```bash
# terminal 1 — stub
node examples/mock-ollama/server.mjs

# terminal 2 — Copilot BYOK (no GitHub Copilot account)
# packages must be built: npm run build -w a2a-copilot
export COPILOT_PROVIDER_BASE_URL=http://127.0.0.1:11434/v1
export COPILOT_PROVIDER_API_KEY=ollama
export COPILOT_PROVIDER_WIRE_API=responses
export COPILOT_MODEL=mock-ollama
node a2a-copilot/dist/cli.js --config examples/mock-ollama/agents/copilot.json

# terminal 3 — Claude via Anthropic-compatible base URL
export ANTHROPIC_BASE_URL=http://127.0.0.1:11434
export ANTHROPIC_API_KEY=ollama
export ANTHROPIC_AUTH_TOKEN=ollama
node a2a-claude/dist/cli.js --config examples/mock-ollama/agents/claude.json
```

Or one-shot smoke (starts mock + both agents + `message/send`):

```bash
node examples/mock-ollama/smoke.mjs
```

## Env knobs

| Var | Default | Meaning |
|---|---|---|
| `MOCK_OLLAMA_PORT` | `11434` | listen port |
| `MOCK_OLLAMA_MODEL` | `mock-ollama` | model id returned / accepted |
| `MOCK_OLLAMA_REPLY` | `pong-from-mock-ollama` | assistant text |

Debug: `GET /__mock__/requests` returns the request log.

## When to use this

- Local A2A cookouts without Copilot subscription / Claude login
- Regression tests for sessions, streaming, artifacts, usage, **OTel**, memory, …
- CI / sandboxes where real LLM calls are blocked by policy

This is **not** a substitute for `agents/ollama/` (real Ollama + real model).
Use real Ollama when you need tool-calling quality; use this stub when you need
a deterministic “LLM answered” signal.

## Related

- OTel + Phoenix cookout that consumes this stub: [`examples/otel-stack`](../otel-stack)
- Real Ollama agent: [`a2a-copilot/agents/ollama`](../../a2a-copilot/agents/ollama)
