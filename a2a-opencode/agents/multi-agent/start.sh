#!/usr/bin/env bash
###############################################################################
# Multi-Agent Example — start / stop / status / logs
#
# Demonstrates the `subAgents` config — see config.json for details.
#
# Set EXAMPLE_TOKEN before starting if you want the bearer auth path on the
# `coding` sub-agent to actually present credentials. When the variable is
# unset, the parent logs a warning and omits the auth block (the bridge
# will still try to call the sub-agent — without auth).
#
# Usage:
#   ./start.sh start          — Start the agent in the background
#   ./start.sh stop           — Stop the running agent
#   ./start.sh restart        — Stop then start
#   ./start.sh status         — Show running / stopped status
#   ./start.sh logs           — Tail all logs
#   ./start.sh logs opencode  — Tail the OpenCode subprocess log only
#   ./start.sh logs a2a       — Tail the A2A server log only
#   ./start.sh foreground     — Run in the foreground (useful for debugging)
#
# OpenCode 2.x needs its server password. Export it before starting so both the
# OpenCode server and the wrapper pick it up:
#   export OPENCODE_SERVER_PASSWORD=change-me
###############################################################################

set -euo pipefail

AGENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${AGENT_DIR}/../.." && pwd)"

export CONFIG_FILE="${AGENT_DIR}/config.json"
export WORKSPACE_DIR="${WORKSPACE_DIR:-${AGENT_DIR}/workspace}"

exec "${ROOT_DIR}/server.sh" "$@"
