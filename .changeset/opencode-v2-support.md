---
"a2a-opencode": minor
---

Support OpenCode 2.x alongside 1.x (#60). OpenCode 2 moved its whole server API under `/api/*`, requires HTTP Basic auth, and admits prompts to a durable inbox, so the 1.x client could not talk to it.

- New 2.x client built on `@opencode/client`, behind a common `OpenCodeBackend` interface. The executor, session manager, permission handler and MCP manager are unchanged in behaviour and work with either generation.
- `opencode.apiVersion` (`auto` | `1` | `2`, default `auto`) selects the protocol. `auto` probes `GET /api/info`; if the server is unreachable at startup, 1.x is assumed as before.
- New `--api-version <auto|1|2>` CLI flag. There is deliberately no password flag (it would leak into process listings and shell history); use `OPENCODE_SERVER_PASSWORD`.
- New `opencode.password` / `opencode.username` options and `OPENCODE_SERVER_PASSWORD` / `OPENCODE_API_VERSION` environment variables. A missing or wrong 2.x password now fails at startup with a clear message instead of at the first API call.
- Forcing `apiVersion: "1"` against a 2.x server also fails at startup with a clear version error.
- The event stream now waits (up to 5s) for the subscription to be live before a prompt is sent, and `disconnect()` aborts the underlying stream.
- Fix: a fatal startup error no longer aborts the process on Windows with a libuv `Assertion failed ... UV_HANDLE_CLOSING` message. The CLI now exits via `process.exitCode` (with a forced-exit fallback) and the version probes release their HTTP response bodies.
- `Promise.withResolvers` is polyfilled for Node 20, which `@opencode/client` needs for its event stream (Node 22+ has it natively).
- Absolute project directories are passed through in either POSIX or Windows style, so the wrapper and the OpenCode server may run on different operating systems.
- README gains a tested-versions matrix (OpenCode 1.19.6 and 2.3.2) and notes on 2.x behaviour differences. The JSON schema, `.env.example`, example agent configs and `start.sh` headers, CLI `--help`, and `docs/security.md` are updated for the new options; `server.sh` warns when 2.x generated a random password.
