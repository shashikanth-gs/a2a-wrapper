#!/usr/bin/env bash
###############################################################################
# Read-Only Reviewer Agent — start / stop / status / logs
#
# Code review and repository analysis agent backed by Claude Code.
# Claude Code is restricted to read-only access — it cannot modify any files.
# Safe to point at any repository without risk of accidental changes.
#
# Usage:
#   ./start.sh start        — Start the agent in the background
#   ./start.sh stop         — Stop the running agent
#   ./start.sh restart      — Stop then start
#   ./start.sh status       — Show running / stopped status
#   ./start.sh logs         — Tail the agent log
#   ./start.sh foreground   — Run in the foreground (useful for debugging)
#
# Required environment:
#   ANTHROPIC_API_KEY   Your Anthropic API key
#
# Point at any repository with WORKSPACE_DIR:
#   WORKSPACE_DIR=/path/to/repo ./start.sh start
###############################################################################

set -euo pipefail

AGENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${AGENT_DIR}/../.." && pwd)"

# CONFIG_FILE points to this agent's JSON configuration.
export CONFIG_FILE="${AGENT_DIR}/config.json"

# WORKSPACE_DIR is the Git repository Claude operates on.
# Defaults to the bundled workspace/ directory — replace with a real repo path.
export WORKSPACE_DIR="${WORKSPACE_DIR:-${AGENT_DIR}/workspace}"

exec "${ROOT_DIR}/server.sh" "$@"
