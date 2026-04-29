#!/usr/bin/env bash
# validate-path.sh — Validates a file path for safety before operations.
#
# Usage: validate-path.sh <workspace_root> <target_path>
#
# Exit codes:
#   0 — path is valid and safe
#   1 — path escapes workspace boundary
#   2 — path contains disallowed characters
#   3 — invalid arguments

set -euo pipefail

if [ $# -ne 2 ]; then
  echo "Usage: validate-path.sh <workspace_root> <target_path>" >&2
  exit 3
fi

WORKSPACE_ROOT="$(realpath "$1")"
TARGET_PATH="$(realpath -m "$2")"

# Check that the target path is within the workspace boundary
if [[ "$TARGET_PATH" != "$WORKSPACE_ROOT"* ]]; then
  echo "Error: path escapes workspace boundary" >&2
  echo "  workspace: $WORKSPACE_ROOT" >&2
  echo "  target:    $TARGET_PATH" >&2
  exit 1
fi

# Check for disallowed characters in the filename
FILENAME="$(basename "$TARGET_PATH")"
if [[ "$FILENAME" =~ [^a-zA-Z0-9._\ -] ]]; then
  echo "Error: filename contains disallowed characters: $FILENAME" >&2
  exit 2
fi

echo "Path is valid: $TARGET_PATH"
exit 0
