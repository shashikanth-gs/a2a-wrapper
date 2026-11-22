---
"@a2a-wrapper/core": minor
---

Core pieces the Claude provider needs (#111), all additive for wrappers; behaviour change in one place, below.

- **A rebind to a different session ref resets the binding's `createdAt`** (the owner is kept; binding the same ref again keeps it). `bindingMaxAgeMs` therefore measures the age of the session the binding names, also when a provider replaces a context's session without deleting the binding first. This changes what a rebind did before (it kept `createdAt`), and the existing core test that asserted it is updated.
- `CoreError.meta`: JSON-safe machine-readable extras rendered as metadata of the failed or rejected status (`code` and `retryable` win over a key of the same name), so a wrapper keeps details such as a rate limit's reset time.
- `createResponseStream` accepts an optional artifact `id` (default `response-<uuid>`).
