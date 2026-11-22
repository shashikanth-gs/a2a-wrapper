---
"a2a-copilot": minor
---

The pre-tool hook of a Copilot session (which approves a tool call itself when nobody could answer) now follows the interaction policy of the run runtime (`CoreRequest.interactionMode`) instead of the provider's own `interactions` config (#124). The two are the same in a normal deployment; the difference matters only for a program that builds the runtime with another policy. No other change.
