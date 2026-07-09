#!/usr/bin/env bash
###############################################################################
# server.sh — Lifecycle manager for A2A Claude agents
#
# Manages the a2a-claude wrapper process as a background service.
#
# Usage via per-agent start.sh (recommended):
#   agents/example/start.sh start
#   agents/my-agent/start.sh start
#
# Or directly:
#   CONFIG_FILE=agents/example/config.json ./server.sh start
#   ./server.sh start --config agents/example/config.json
#
# Required environment:
#   ANTHROPIC_API_KEY   Your Anthropic API key
#   WORKSPACE_DIR    Absolute path to the Git repo Claude will operate on
###############################################################################

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ─── Colors ──────────────────────────────────────────────────────────────────

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
info()    { echo -e "${BLUE}ℹ${NC}  $*"; }
ok()      { echo -e "${GREEN}✓${NC}  $*"; }
warn()    { echo -e "${YELLOW}⚠${NC}  $*"; }
err()     { echo -e "${RED}✗${NC}  $*"; }

# ─── Resolve CONFIG_FILE ─────────────────────────────────────────────────────

resolve_config() {
  if [[ -n "${CONFIG_FILE:-}" ]]; then return 0; fi

  local args=("$@")
  for ((i=0; i<${#args[@]}; i++)); do
    if [[ "${args[$i]}" == "--config" ]] && (( i+1 < ${#args[@]} )); then
      CONFIG_FILE="${args[$((i+1))]}"
      return 0
    fi
  done

  err "No config file specified. Use CONFIG_FILE env var or --config <path>"
  exit 1
}

# ─── Read JSON config ─────────────────────────────────────────────────────────

cfg() {
  local expr="$1" default="${2:-}"
  local val
  val=$(node -e "
    const c = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
    const v = ${expr};
    process.stdout.write(v != null ? String(v) : '');
  " "$CONFIG_FILE" 2>/dev/null) || true
  echo "${val:-$default}"
}

# ─── Derive paths / ports from config ────────────────────────────────────────

setup_env() {
  AGENT_DIR="$(cd "$(dirname "$CONFIG_FILE")" && pwd)"
  AGENT_NAME="$(cfg 'c.agentCard?.name' 'agent')"
  A2A_PORT="$(cfg 'c.server?.port' '3030')"

  A2A_PID_FILE="${AGENT_DIR}/.a2a.pid"
  A2A_LOG_FILE="${AGENT_DIR}/a2a.log"
}

# ─── Process helpers ──────────────────────────────────────────────────────────

check_pid() {
  local pidfile="$1"
  if [[ -f "$pidfile" ]]; then
    local pid
    pid=$(<"$pidfile")
    if kill -0 "$pid" 2>/dev/null; then
      echo "$pid"
      return 0
    fi
    rm -f "$pidfile"
  fi
  return 1
}

stop_process() {
  local pidfile="$1" label="$2"
  local pid
  if ! pid=$(check_pid "$pidfile"); then
    info "${label} is not running"
    return 0
  fi
  info "Stopping ${label} (PID ${pid})…"
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 10); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 1
  done
  if kill -0 "$pid" 2>/dev/null; then
    warn "Force killing ${label}…"
    kill -9 "$pid" 2>/dev/null || true
  fi
  rm -f "$pidfile"
  ok "${label} stopped"
}

# ─── A2A wrapper lifecycle ────────────────────────────────────────────────────

ensure_built() {
  if [[ ! -d "${SCRIPT_DIR}/dist" ]]; then
    info "No dist/ found — building…"
    (cd "$SCRIPT_DIR" && npm run build)
  fi
}

validate_env() {
  if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
    warn "ANTHROPIC_API_KEY is not set — the agent will fail unless Bedrock/Vertex/OAuth env auth is configured."
  fi
  if [[ -z "${WORKSPACE_DIR:-}" ]]; then
    warn "WORKSPACE_DIR is not set — using config value or failing at startup."
  fi
}

start_a2a() {
  if pid=$(check_pid "$A2A_PID_FILE"); then
    info "a2a-claude already running (PID ${pid})"
    return 0
  fi

  ensure_built
  validate_env

  info "Starting a2a-claude (${AGENT_NAME}, port ${A2A_PORT})"
  nohup node "${SCRIPT_DIR}/dist/cli.js" --config "$CONFIG_FILE" \
    >> "$A2A_LOG_FILE" 2>&1 &
  local pid=$!
  echo "$pid" > "$A2A_PID_FILE"

  sleep 2
  if kill -0 "$pid" 2>/dev/null; then
    ok "a2a-claude started (PID ${pid}, port ${A2A_PORT})"
  else
    err "a2a-claude failed to start — check ${A2A_LOG_FILE}"
    tail -20 "$A2A_LOG_FILE" 2>/dev/null || true
    rm -f "$A2A_PID_FILE"
    return 1
  fi
}

stop_a2a() {
  stop_process "$A2A_PID_FILE" "a2a-claude"
}

# ─── Commands ─────────────────────────────────────────────────────────────────

cmd_start() {
  start_a2a || { err "Start failed"; return 1; }

  echo ""
  ok "=== ${AGENT_NAME} Ready ==="
  echo "  A2A Wrapper:   http://localhost:${A2A_PORT}"
  echo "  Agent Card:    http://localhost:${A2A_PORT}/.well-known/agent-card.json"
  echo "  JSON-RPC:      http://localhost:${A2A_PORT}/a2a/jsonrpc"
  echo "  REST API:      http://localhost:${A2A_PORT}/a2a/rest"
  echo "  Context:       http://localhost:${A2A_PORT}/context"
  echo "  Build Context: http://localhost:${A2A_PORT}/context/build  [POST]"
  echo "  Health Check:  http://localhost:${A2A_PORT}/health"
  echo ""
  echo "  Logs: ${A2A_LOG_FILE}"
}

cmd_stop() {
  stop_a2a
  echo ""
  ok "${AGENT_NAME} stopped"
}

cmd_restart() {
  cmd_stop
  sleep 1
  cmd_start
}

cmd_status() {
  local a2a_running=false
  local a2a_pid=""

  if a2a_pid=$(check_pid "$A2A_PID_FILE"); then a2a_running=true; fi

  echo ""
  echo "  Agent: ${AGENT_NAME}"
  echo ""
  if $a2a_running; then
    echo -e "  ${GREEN}✓${NC} a2a-claude: RUNNING (PID ${a2a_pid}, port ${A2A_PORT})"
    if command -v curl &>/dev/null; then
      local health
      health=$(curl -sf "http://localhost:${A2A_PORT}/health" 2>/dev/null) || true
      [[ -n "$health" ]] && echo "               Health: ${health}"
    fi
  else
    echo -e "  ${RED}✗${NC} a2a-claude: STOPPED"
  fi
  echo ""
  echo "  Config:    ${CONFIG_FILE}"
  echo "  Workspace: ${WORKSPACE_DIR:-"(from config)"}"
  echo ""
}

cmd_logs() {
  if [[ -f "$A2A_LOG_FILE" ]]; then
    tail -f "$A2A_LOG_FILE"
  else
    warn "No log file found at ${A2A_LOG_FILE}"
  fi
}

cmd_foreground() {
  ensure_built
  validate_env
  info "Starting a2a-claude in foreground (${AGENT_NAME})"
  exec node "${SCRIPT_DIR}/dist/cli.js" --config "$CONFIG_FILE"
}

# ─── Main ─────────────────────────────────────────────────────────────────────

usage() {
  cat <<EOF
Usage: $0 {start|stop|restart|status|logs|foreground} [options]

Manages a2a-claude for a given agent config.
Config is read from CONFIG_FILE env var or --config <path>.

Commands:
  start               Start a2a-claude in the background
  stop                Stop the wrapper process
  restart             Restart the wrapper
  status              Show running status and health
  logs                Tail the log file
  foreground          Start in the foreground (useful for debugging / Docker)

Environment:
  CONFIG_FILE         Path to agent config.json (required)
  ANTHROPIC_API_KEY   Anthropic API key (required unless Bedrock/Vertex/OAuth env auth is configured)
  WORKSPACE_DIR       Git repository path for Claude to operate on

Examples:
  export ANTHROPIC_API_KEY=sk-ant-... WORKSPACE_DIR=/path/to/repo
  CONFIG_FILE=agents/example/config.json ./server.sh start
  agents/example/start.sh start
  agents/my-agent/start.sh status
EOF
}

resolve_config "$@"
[[ "$CONFIG_FILE" != /* ]] && CONFIG_FILE="${SCRIPT_DIR}/${CONFIG_FILE}"

if [[ ! -f "$CONFIG_FILE" ]]; then
  err "Config file not found: ${CONFIG_FILE}"
  exit 1
fi

setup_env

COMMAND="${1:-}"
shift || true
FILTERED_ARGS=()
skip_next=false
for arg in "$@"; do
  if $skip_next; then skip_next=false; continue; fi
  if [[ "$arg" == "--config" ]]; then skip_next=true; continue; fi
  FILTERED_ARGS+=("$arg")
done

case "$COMMAND" in
  start)      cmd_start ;;
  stop)       cmd_stop ;;
  restart)    cmd_restart ;;
  status)     cmd_status ;;
  logs)       cmd_logs ;;
  foreground) cmd_foreground ;;
  help|--help|-h) usage ;;
  *)          usage; exit 1 ;;
esac
