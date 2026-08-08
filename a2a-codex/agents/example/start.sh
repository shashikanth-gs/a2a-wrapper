#!/usr/bin/env bash
###############################################################################
# Example Agent — start / stop / status / logs
#
# Minimal workspace engineering agent backed by OpenAI Codex.
# Codex can read and write files inside the workspace directory.
#
# Copy this directory to create your own agent:
#   cp -r agents/example agents/my-agent
#
# Usage:
#   ./start.sh start        — Start the agent in the background
#   ./start.sh stop         — Stop the running agent
#   ./start.sh restart      — Stop then start
#   ./start.sh status       — Show running / stopped status
#   ./start.sh logs         — Tail the agent log
#   ./start.sh foreground   — Run in the foreground (useful for debugging)
#
# Authentication (choose one):
#   OPENAI_API_KEY   Your OpenAI API key
#   codex login      ChatGPT subscription credentials; also set CODEX_MODEL
#
# The WORKSPACE_DIR defaults to the workspace/ subdirectory in this agent
# folder. Override by setting the env variable before calling this script:
#   WORKSPACE_DIR=/my/repo ./start.sh start
###############################################################################

set -euo pipefail

AGENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${AGENT_DIR}/../.." && pwd)"

# CONFIG_FILE points to this agent's JSON configuration.
export CONFIG_FILE="${AGENT_DIR}/config.json"

# WORKSPACE_DIR is the Git repository Codex operates on.
# Defaults to the bundled workspace/ directory — replace with a real repo path.
export WORKSPACE_DIR="${WORKSPACE_DIR:-${AGENT_DIR}/workspace}"

exec "${ROOT_DIR}/server.sh" "$@"
