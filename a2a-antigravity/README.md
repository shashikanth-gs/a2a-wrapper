# a2a-antigravity

A2A wrapper for the Google Antigravity Python SDK.

The public server is TypeScript/Node and follows the same A2A HTTP, JSON-RPC,
REST, and SSE behavior as the other wrappers in this monorepo. Python is used
only as a private bridge to `google-antigravity`.

## Install Runtime Prerequisites

Install the Python SDK in the Python environment used by `antigravity.pythonPath`:

```bash
python3 -m pip install google-antigravity
```

## Model Access

The wrapper supports the auth surfaces exposed by the current Python SDK:

- `sdkDefault`: omit provider auth fields and let the SDK read environment/defaults.
- `apiKey`: Gemini Developer API / AI Studio key via `GEMINI_API_KEY` or `provider.apiKey`.
- `adc`: Vertex / Gemini Enterprise Agent Platform with Application Default Credentials.

Google AI Pro/Ultra product-login OAuth is not exposed by `google-antigravity`
0.1.5 as a public Python SDK config surface, so this wrapper does not implement
an unofficial subscription-login path.

## Run

```bash
GEMINI_API_KEY=... WORKSPACE_DIR=/path/to/repo npm run dev -w a2a-antigravity -- --config agents/example/config.json
```

Vertex/ADC:

```bash
gcloud auth application-default login
npm run dev -w a2a-antigravity -- \
  --workspace /path/to/repo \
  --auth-mode adc \
  --project my-gcp-project \
  --location us-central1
```

## Config Shape

Common wrapper concerns stay top-level: `agentCard`, `server`, `session`,
`features`, `timeouts`, `logging`, `events`, `memory`, `mcp`, and `subAgents`.

Antigravity-specific runtime settings live under `antigravity`. Provider/model
auth and routing stay under `antigravity.provider`.

Unset SDK-owned fields are omitted from the Python bridge config so SDK defaults
remain authoritative.
