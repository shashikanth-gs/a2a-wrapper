#!/usr/bin/env bash
###############################################################################
# Example Agent — local-source runner
#
# Minimal workspace engineering agent backed by Google Antigravity.
#
# Usage:
#   ./start.sh
#   ./start.sh --port 3130 --log-level debug
#   CONFIG_FILE=./config.run-command.json ./start.sh
#
# Required runtime:
#   python3 -m pip install google-antigravity
#
# Model access:
#   GEMINI_API_KEY=... ./start.sh
#   gcloud auth application-default login
#   ./start.sh --auth-mode adc --project my-project --location us-central1
#
# WORKSPACE_DIR defaults to the repository root when this script is run from
# the monorepo checkout. Override it for your own target project:
#   WORKSPACE_DIR=/my/repo ./start.sh
#
# The default config keeps Antigravity SDK command policy defaults. Use
# config.run-command.json only in trusted workspaces where shell execution is
# expected.
###############################################################################

set -euo pipefail

AGENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(cd "${AGENT_DIR}/../.." && pwd)"
MONOREPO_DIR="$(cd "${PACKAGE_DIR}/.." && pwd)"

export CONFIG_FILE="${CONFIG_FILE:-${AGENT_DIR}/config.json}"
export WORKSPACE_DIR="${WORKSPACE_DIR:-${MONOREPO_DIR}}"

exec npx --yes --package "${PACKAGE_DIR}" a2a-antigravity \
  --config "${CONFIG_FILE}" \
  "$@"
