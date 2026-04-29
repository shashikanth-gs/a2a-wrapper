---
name: file-operations
description: Provides safe file read, write, and search operations with validation and error handling
license: MIT
compatibility:
  - copilot
  - opencode-claude
---

# File Operations Skill

This skill equips the agent with structured guidelines for performing filesystem
operations safely and reliably.

## Capabilities

- **Read**: Read file contents with encoding detection and size checks.
- **Write**: Create or overwrite files with atomic write semantics.
- **Search**: Find files by name pattern or content substring.
- **List**: Enumerate directory contents with optional recursion.
- **Validate**: Check paths for safety before performing operations.

## Usage Guidelines

Before writing a file, always validate the target path using the validation
script in `scripts/validate-path.sh`. This ensures:

1. The path does not escape the workspace boundary.
2. The filename uses allowed characters only.
3. The target directory exists or can be created.

## Error Handling

- If a read operation fails, report the error type (not found, permission denied,
  encoding error) to the user with a suggested action.
- If a write operation fails, do not retry automatically — inform the user and
  await further instructions.
- Log all operations for auditability.
