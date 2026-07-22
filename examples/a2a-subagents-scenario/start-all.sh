#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# start-all.sh — Start both sub-agents and run the end-to-end scenario test
#
# Usage:
#   ./start-all.sh          # start agents, run test, stop agents
#   ./start-all.sh agents   # start agents only (leave running for manual use)
#   ./start-all.sh test     # run test only (assumes agents are already running)
#   ./start-all.sh stop     # stop any agents started by this script
#
# The agents run in the background. Their logs go to:
#   /tmp/a2a-coding-agent.log
#   /tmp/a2a-research-agent.log
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
CORE_DIST="${REPO_ROOT}/packages/core/dist/index.js"
CODING_LOG="/tmp/a2a-coding-agent.log"
RESEARCH_LOG="/tmp/a2a-research-agent.log"
CODING_PID_FILE="/tmp/a2a-coding-agent.pid"
RESEARCH_PID_FILE="/tmp/a2a-research-agent.pid"

# Ensure @a2a-wrapper/core is compiled. The scenario test imports it from
# packages/core/dist/, which is git-ignored and NOT produced by `npm install`.
ensure_core_built() {
  if [ ! -f "${CORE_DIST}" ]; then
    echo "@a2a-wrapper/core is not built yet — building it now..."
    ( cd "${REPO_ROOT}" && npx turbo run build --filter=@a2a-wrapper/core )
  fi
}

start_agents() {
  echo "Starting coding-agent on :4101..."
  node "${SCRIPT_DIR}/agents/coding-agent.mjs" > "${CODING_LOG}" 2>&1 &
  echo $! > "${CODING_PID_FILE}"

  echo "Starting research-agent on :4102..."
  node "${SCRIPT_DIR}/agents/research-agent.mjs" > "${RESEARCH_LOG}" 2>&1 &
  echo $! > "${RESEARCH_PID_FILE}"

  # Wait for both agents to be ready.
  echo "Waiting for agents to start..."
  for i in $(seq 1 10); do
    if curl -sf http://127.0.0.1:4101/health > /dev/null 2>&1 && \
       curl -sf http://127.0.0.1:4102/health > /dev/null 2>&1; then
      echo "Both agents are ready."
      return 0
    fi
    sleep 0.5
  done
  echo "ERROR: Agents did not start in time. Check logs:"
  echo "  tail -f ${CODING_LOG}"
  echo "  tail -f ${RESEARCH_LOG}"
  exit 1
}

stop_agents() {
  for pidfile in "${CODING_PID_FILE}" "${RESEARCH_PID_FILE}"; do
    if [ -f "${pidfile}" ]; then
      pid=$(cat "${pidfile}")
      if kill -0 "${pid}" 2>/dev/null; then
        kill "${pid}"
        echo "Stopped agent (pid ${pid})"
      fi
      rm -f "${pidfile}"
    fi
  done
}

run_test() {
  ensure_core_built
  echo ""
  node "${SCRIPT_DIR}/test/run-scenario.mjs"
}

MODE="${1:-all}"

case "${MODE}" in
  agents)
    start_agents
    echo ""
    echo "Agents are running. Logs:"
    echo "  tail -f ${CODING_LOG}"
    echo "  tail -f ${RESEARCH_LOG}"
    echo ""
    echo "Run the test with:  node test/run-scenario.mjs"
    echo "Stop agents with:   ./start-all.sh stop"
    ;;
  test)
    run_test
    ;;
  stop)
    stop_agents
    ;;
  all|*)
    start_agents
    trap stop_agents EXIT
    run_test
    ;;
esac
