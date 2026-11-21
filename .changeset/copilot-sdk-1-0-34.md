---
"a2a-copilot": patch
---

Chore: upgrade `@github/copilot-sdk` from `^1.0.0` (1.0.5) to `^1.0.34`. No wrapper code changes were needed: the default stdio connection to the bundled runtime, `RuntimeConnection.forUri`, `approveAll` and the `createSession` / `sendAndWait` / `abort` surface are source- and behaviour-compatible. The SDK now ships its bundled runtime via platform optional dependencies (`@github/copilot-sdk-<platform>`).
