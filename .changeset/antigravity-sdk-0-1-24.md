---
"a2a-antigravity": patch
---

Upgrade the pinned `google-antigravity` Python SDK from 0.1.5 to 0.1.24 (#87). The bridge now passes `capabilities.compactionThreshold` through `CompactionConfig` on the agent config, because `CapabilitiesConfig.compaction_threshold` is deprecated in the SDK. Python >=3.10 is still supported. Note the SDK's own changes: `ASK_QUESTION` is no longer in the default tool set, and the built-in `START_SUBAGENT` tool was renamed `INVOKE_SUBAGENT`.
