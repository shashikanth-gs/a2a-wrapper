---
"@a2a-wrapper/core": minor
"a2a-copilot": minor
"a2a-codex": minor
"a2a-claude": patch
"a2a-opencode": patch
"a2a-antigravity": patch
---

Default `model` is now `auto` everywhere: no wrapper pins a model name in code (#95).

- Core: new `AUTO_MODEL`, `isAutoModel` and `normalizeModel`. Unset, empty, `auto` and `default` (any case) all mean "let the provider choose".
- a2a-copilot: the default changes from `claude-sonnet-4.5` to `auto`, passed as the literal `auto`, which the Copilot runtime accepts (the old default is rejected by the runtime bundled with `@github/copilot-sdk` 1.0.34). Example configs no longer pin models. A custom BYOK provider still requires an explicit model.
- a2a-codex: `auto` (the new default) picks the first model Codex lists for the logged-in account (`codex debug models`, then the `models_cache.json` fallback, then Codex's own default), so a stale model pinned in `~/.codex/config.toml` is no longer inherited. Explicit names still win.
- a2a-claude, a2a-opencode, a2a-antigravity: `auto`/`default`/empty resolve to unset so the backend applies its own default.
