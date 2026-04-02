#!/usr/bin/env bash
###############################################################################
# Example Agent — start / stop / status / logs
#
# This is the minimal starter agent. Copy this directory to create your own:
#   cp -r agents/example agents/my-agent
#
# Usage:
#   ./start.sh start        — Start the agent in the background
#   ./start.sh stop         — Stop the running agent
#   ./start.sh restart      — Stop then start
#   ./start.sh status       — Show running / stopped status
#   ./start.sh logs         — Tail the agent log
#   ./start.sh foreground   — Run in the foreground (useful for debugging)
###############################################################################

set -euo pipefail

AGENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${AGENT_DIR}/../.." && pwd)"

# CONFIG_FILE points to this agent's JSON configuration.
export CONFIG_FILE="${AGENT_DIR}/config.json"

# WORKSPACE_DIR is available to the agent at runtime.
# Override by setting the env variable before calling this script.
export WORKSPACE_DIR="${WORKSPACE_DIR:-${AGENT_DIR}/workspace}"

exec "${ROOT_DIR}/server.sh" "$@"
