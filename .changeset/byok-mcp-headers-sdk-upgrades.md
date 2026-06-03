---
"a2a-copilot": minor
"a2a-opencode": minor
"@a2a-wrapper/core": minor
---

## Bring Your Own Model (BYOK) + MCP custom headers + SDK upgrades

### New features

**Bring Your Own Model (BYOK) — `a2a-copilot`**

Point `a2a-copilot` at any OpenAI-compatible endpoint instead of GitHub Copilot. Supports Ollama (local), OpenAI, Anthropic, Azure OpenAI, Azure AI Foundry, vLLM, LiteLLM, and any OpenAI-compatible API. Configure via `copilot.provider` in `config.json` or the same env vars the `gh copilot` CLI uses (`COPILOT_PROVIDER_BASE_URL`, `COPILOT_PROVIDER_TYPE`, `COPILOT_PROVIDER_API_KEY`, `COPILOT_PROVIDER_WIRE_API`). No GitHub Copilot account required when using a custom provider.

```json
{
  "copilot": {
    "model": "qwen3.6",
    "provider": {
      "type": "openai",
      "baseUrl": "http://localhost:11434/v1",
      "wireApi": "completions"
    }
  }
}
```

New bundled example: `agents/ollama/` — a ready-to-run local agent backed by Ollama (verified with `qwen3.6`).

**MCP custom headers — `a2a-copilot` + `a2a-opencode`**

Remote MCP servers (http/sse) now accept a `headers` map for auth tokens, API keys, etc. Values support `${ENV_VAR}` substitution so secrets stay out of `config.json`.

```json
"mcp": {
  "linear": {
    "type": "http",
    "url": "https://mcp.linear.app/mcp",
    "headers": { "Authorization": "Bearer ${LINEAR_API_KEY}" }
  }
}
```

**Env-var substitution extended — both wrappers**

`${VAR}` (explicit, mid-string) and `$VAR` (bare, backward-compatible) substitution now applies to: stdio `args`, stdio `env`/`environment` values, and http/sse/remote `headers`. The shared helpers (`substituteEnvTokensInString`, `substituteEnvTokensInRecord`) are now exported from `@a2a-wrapper/core` — no more duplication between wrappers.

### Bug fixes

- **BYOK models emitting tool calls as plain text** — when a BYOK provider is configured and the model returns a raw `{"name":...,"arguments":...}` JSON object instead of a proper response (common with small local models that lack native tool-calling support), the wrapper now detects it and returns an actionable message instead of leaking raw JSON.
- **Logger level propagation** — `level: "debug"` in config now correctly reaches all child loggers. Previously, child loggers captured the level at module-import time before the config was loaded.

### SDK upgrades

- **`a2a-copilot`**: `@github/copilot-sdk` `0.2.2 → 1.0.0`, `@github/copilot` `1.0.39 → 1.0.59`. SDK 1.0.0 introduces `RuntimeConnection` factories and renames `session.destroy()` to `session.disconnect()`. The CLI upgrade (1.0.39 → 1.0.59) includes the BYOK provider fix (v1.0.56) that ensures custom providers work correctly in headless SDK sessions.
- **`a2a-opencode`**: `@opencode-ai/sdk` `1.14.29 → 1.15.13`. No breaking changes; v2 API surface is additive.
