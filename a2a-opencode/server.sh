#!/usr/bin/env bash
###############################################################################
# server.sh — Generic lifecycle manager for A2A OpenCode agents
#
# Manages BOTH the OpenCode server and the A2A wrapper process.
# Reads all settings (ports, workspace, etc.) from the agent's config.json.
#
# Usage via per-agent start.sh (recommended):
#   agents/example/start.sh start
#   agents/example/start.sh stop
#   agents/my-agent/start.sh start
#
# Or directly:
#   CONFIG_FILE=agents/example/config.json ./server.sh start
#   ./server.sh start --config agents/example/config.json
###############################################################################

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ─── Colors ──────────────────────────────────────────────────────────────────

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
info()    { echo -e "${BLUE}ℹ${NC}  $*"; }
ok()      { echo -e "${GREEN}✓${NC}  $*"; }
warn()    { echo -e "${YELLOW}⚠${NC}  $*"; }
err()     { echo -e "${RED}✗${NC}  $*"; }

# ─── Resolve CONFIG_FILE ────────────────────────────────────────────────────

resolve_config() {
  # Already set by per-agent start.sh or env
  if [[ -n "${CONFIG_FILE:-}" ]]; then return 0; fi

  # Check CLI args for --config
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

# ─── Read JSON config (uses Node since it's already a dependency) ────────────

cfg() {
  # Usage: cfg '.opencode.baseUrl' [default]
  local expr="$1" default="${2:-}"
  local val
  val=$(node -e "
    const c = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
    const v = ${expr};
    process.stdout.write(v != null ? String(v) : '');
  " "$CONFIG_FILE" 2>/dev/null) || true
  echo "${val:-$default}"
}

# ─── Derive all paths / ports from config ────────────────────────────────────

setup_env() {
  # Agent directory = parent of config.json
  AGENT_DIR="$(cd "$(dirname "$CONFIG_FILE")" && pwd)"
  AGENT_NAME="$(cfg 'c.agentCard?.name' 'agent')"

  # OpenCode
  OC_BASE_URL="$(cfg 'c.opencode?.baseUrl' 'http://localhost:4096')"
  OC_PORT="$(echo "$OC_BASE_URL" | sed -E 's|.*:([0-9]+)/?$|\1|')"
  WORKSPACE_DIR="${WORKSPACE_DIR:-${AGENT_DIR}/workspace}"

  # A2A
  A2A_PORT="$(cfg 'c.server?.port' '3000')"

  # PID / log files — per agent, stored in agent dir
  OC_PID_FILE="${AGENT_DIR}/.opencode.pid"
  OC_LOG_FILE="${AGENT_DIR}/opencode.log"
  A2A_PID_FILE="${AGENT_DIR}/.a2a.pid"
  A2A_LOG_FILE="${AGENT_DIR}/a2a.log"
}

# ─── Process helpers ─────────────────────────────────────────────────────────

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

# ─── OpenCode lifecycle ─────────────────────────────────────────────────────

start_opencode() {
  if pid=$(check_pid "$OC_PID_FILE"); then
    info "OpenCode already running (PID ${pid})"
    return 0
  fi

  if ! command -v opencode &>/dev/null; then
    warn "opencode binary not found — skipping (start it manually on port ${OC_PORT})"
    return 0
  fi

  if [[ ! -d "$WORKSPACE_DIR" ]]; then
    info "Creating workspace directory: ${WORKSPACE_DIR}"
    mkdir -p "$WORKSPACE_DIR"
  fi

  info "Starting OpenCode on port ${OC_PORT} (workspace: ${WORKSPACE_DIR})"
  (
    cd "$WORKSPACE_DIR"
    nohup opencode serve --port "$OC_PORT" > "$OC_LOG_FILE" 2>&1 &
    echo $! > "$OC_PID_FILE"
  )

  # Wait for it to be reachable
  for i in $(seq 1 15); do
    if pid=$(check_pid "$OC_PID_FILE"); then
      if curl -sf "http://localhost:${OC_PORT}/health" >/dev/null 2>&1; then
        ok "OpenCode started (PID ${pid}, port ${OC_PORT})"
        return 0
      fi
    fi
    sleep 1
  done

  if pid=$(check_pid "$OC_PID_FILE"); then
    warn "OpenCode started (PID ${pid}) but health check not responding yet"
  else
    err "OpenCode failed to start — check ${OC_LOG_FILE}"
    tail -20 "$OC_LOG_FILE" 2>/dev/null || true
    return 1
  fi
}

stop_opencode() {
  stop_process "$OC_PID_FILE" "OpenCode"
}

# ─── A2A wrapper lifecycle ──────────────────────────────────────────────────

ensure_built() {
  if [[ ! -d "${SCRIPT_DIR}/dist" ]]; then
    info "No dist/ found — building…"
    (cd "$SCRIPT_DIR" && npm run build)
  fi
}

start_a2a() {
  if pid=$(check_pid "$A2A_PID_FILE"); then
    info "A2A wrapper already running (PID ${pid})"
    return 0
  fi

  ensure_built

  info "Starting A2A wrapper (${AGENT_NAME}, port ${A2A_PORT})"
  nohup node "${SCRIPT_DIR}/dist/cli.js" --config "$CONFIG_FILE" \
    >> "$A2A_LOG_FILE" 2>&1 &
  local pid=$!
  echo "$pid" > "$A2A_PID_FILE"

  sleep 2
  if kill -0 "$pid" 2>/dev/null; then
    ok "A2A wrapper started (PID ${pid}, port ${A2A_PORT})"
  else
    err "A2A wrapper failed to start — check ${A2A_LOG_FILE}"
    tail -20 "$A2A_LOG_FILE" 2>/dev/null || true
    rm -f "$A2A_PID_FILE"
    return 1
  fi
}

stop_a2a() {
  stop_process "$A2A_PID_FILE" "A2A wrapper"
}

# ─── Commands ────────────────────────────────────────────────────────────────

cmd_start() {
  start_opencode || { err "OpenCode start failed"; return 1; }
  start_a2a      || { err "A2A start failed"; stop_opencode; return 1; }

  echo ""
  ok "=== ${AGENT_NAME} Ready ==="
  echo "  OpenCode:    http://localhost:${OC_PORT}"
  echo "  A2A Wrapper: http://localhost:${A2A_PORT}"
  echo "  Agent Card:    http://localhost:${A2A_PORT}/.well-known/agent-card.json"
  echo "  JSON-RPC:      http://localhost:${A2A_PORT}/a2a/jsonrpc"
  echo "  REST API:      http://localhost:${A2A_PORT}/a2a/rest"
  echo "  Context:       http://localhost:${A2A_PORT}/context"
  echo "  Build Context: http://localhost:${A2A_PORT}/context/build  [POST]"
  echo "  Health Check:  http://localhost:${A2A_PORT}/health"
  echo "  Workspace:     ${WORKSPACE_DIR}"
  echo ""
  echo "  Logs:"
  echo "    OpenCode:  ${OC_LOG_FILE}"
  echo "    A2A:       ${A2A_LOG_FILE}"
}

cmd_stop() {
  stop_a2a
  stop_opencode
  echo ""
  ok "${AGENT_NAME} stopped"
}

cmd_restart() {
  cmd_stop
  sleep 1
  cmd_start
}

cmd_status() {
  local oc_running=false a2a_running=false
  local oc_pid="" a2a_pid=""

  if oc_pid=$(check_pid "$OC_PID_FILE"); then oc_running=true; fi
  if a2a_pid=$(check_pid "$A2A_PID_FILE"); then a2a_running=true; fi

  echo ""
  echo "  Agent: ${AGENT_NAME}"
  echo ""
  if $oc_running; then
    echo -e "  ${GREEN}✓${NC} OpenCode:    RUNNING (PID ${oc_pid}, port ${OC_PORT})"
  else
    echo -e "  ${RED}✗${NC} OpenCode:    STOPPED"
  fi
  if $a2a_running; then
    echo -e "  ${GREEN}✓${NC} A2A Wrapper: RUNNING (PID ${a2a_pid}, port ${A2A_PORT})"
    if command -v curl &>/dev/null; then
      local health
      health=$(curl -sf "http://localhost:${A2A_PORT}/health" 2>/dev/null) || true
      [[ -n "$health" ]] && echo "               Health: ${health}"
    fi
  else
    echo -e "  ${RED}✗${NC} A2A Wrapper: STOPPED"
  fi
  echo ""
  echo "  Config:    ${CONFIG_FILE}"
  echo "  Workspace: ${WORKSPACE_DIR}"
  echo ""
}

cmd_logs() {
  local target="${1:-all}"
  case "$target" in
    opencode|oc)
      [[ -f "$OC_LOG_FILE" ]] && tail -f "$OC_LOG_FILE" || warn "No OpenCode log file"
      ;;
    a2a|wrapper)
      [[ -f "$A2A_LOG_FILE" ]] && tail -f "$A2A_LOG_FILE" || warn "No A2A log file"
      ;;
    all|*)
      if [[ -f "$A2A_LOG_FILE" ]] && [[ -f "$OC_LOG_FILE" ]]; then
        tail -f "$OC_LOG_FILE" "$A2A_LOG_FILE"
      elif [[ -f "$A2A_LOG_FILE" ]]; then
        tail -f "$A2A_LOG_FILE"
      elif [[ -f "$OC_LOG_FILE" ]]; then
        tail -f "$OC_LOG_FILE"
      else
        warn "No log files found"
      fi
      ;;
  esac
}

cmd_foreground() {
  start_opencode || { err "OpenCode start failed"; exit 1; }
  ensure_built
  info "Starting A2A wrapper in foreground (${AGENT_NAME})"
  exec node "${SCRIPT_DIR}/dist/cli.js" --config "$CONFIG_FILE"
}

# ─── Main ────────────────────────────────────────────────────────────────────

usage() {
  cat <<EOF
Usage: $0 {start|stop|restart|status|logs|foreground} [options]

Manages both the OpenCode server and the A2A wrapper for a given agent.
Config is read from CONFIG_FILE env var or --config <path>.

Commands:
  start               Start OpenCode + A2A wrapper in background
  stop                Stop both processes
  restart             Restart both
  status              Show running status of both processes
  logs [target]       Tail logs (target: all, opencode, a2a)
  foreground          Start OpenCode bg + A2A wrapper in foreground

Environment:
  CONFIG_FILE         Path to agent config.json (required)
  WORKSPACE_DIR       Override OpenCode workspace (default: <agent_dir>/workspace)

Examples:
  CONFIG_FILE=agents/example/config.json ./server.sh start
  agents/example/start.sh start
  agents/example/start.sh status
  agents/example/start.sh logs opencode
EOF
}

# Resolve config from env or args
resolve_config "$@"
# Make CONFIG_FILE absolute
[[ "$CONFIG_FILE" != /* ]] && CONFIG_FILE="${SCRIPT_DIR}/${CONFIG_FILE}"

if [[ ! -f "$CONFIG_FILE" ]]; then
  err "Config file not found: ${CONFIG_FILE}"
  exit 1
fi

setup_env

COMMAND="${1:-}"
shift || true
# Strip --config and its value from remaining args
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
  logs)       cmd_logs "${FILTERED_ARGS[0]:-all}" ;;
  foreground) cmd_foreground ;;
  help|--help|-h) usage ;;
  *)          usage; exit 1 ;;
esac
