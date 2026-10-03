---
"a2a-claude": minor
"@a2a-wrapper/core": patch
---

Add `claude.outputFormat` to request structured JSON output from the Claude
session. Maps 1:1 onto the Claude Agent SDK's `Options.outputFormat`
(`{ type: "json_schema", schema }`) and is validated at startup. When set, the
SDK's `structured_output` is published as an `application/json` data part on the
`response` artifact, alongside the existing text part — text-only clients are
unaffected, and behaviour is unchanged when `outputFormat` is omitted.

The core change adds an optional, backward-compatible `structuredData` parameter
to `publishFinalArtifact` / `publishLastChunkMarker`.
