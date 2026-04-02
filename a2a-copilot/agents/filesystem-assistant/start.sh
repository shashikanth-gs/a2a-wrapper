#!/usr/bin/env bash
###############################################################################
# Filesystem Assistant Agent — start / stop / status / logs
#
# This agent demonstrates the stdio MCP filesystem integration.
# The agent's LLM gets read/write access to the workspace directory below via
# the @modelcontextprotocol/server-filesystem MCP server.
#
# Usage:
#   ./start.sh start        — Start the agent in the background
#   ./start.sh stop         — Stop the running agent
#   ./start.sh restart      — Stop then start
#   ./start.sh status       — Show running / stopped status
#   ./start.sh logs         — Tail the agent log
#   ./start.sh foreground   — Run in the foreground (useful for debugging)
#
# Override the workspace directory by setting WORKSPACE_DIR before calling:
#   WORKSPACE_DIR=/my/custom/path ./start.sh start
###############################################################################

set -euo pipefail

AGENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${AGENT_DIR}/../.." && pwd)"

# CONFIG_FILE points to this agent's JSON configuration.
export CONFIG_FILE="${AGENT_DIR}/config.json"

# WORKSPACE_DIR is the directory the filesystem MCP server is scoped to.
# The agent's LLM can only read and write files within this directory.
export WORKSPACE_DIR="${WORKSPACE_DIR:-${AGENT_DIR}/workspace}"

exec "${ROOT_DIR}/server.sh" "$@"
