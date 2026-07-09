#!/usr/bin/env python3
"""Private JSONL bridge for a2a-antigravity.

The bridge is deliberately small:
- stdin receives JSON commands from Node.
- stdout emits JSON events only.
- stderr receives logs.

It imports google-antigravity lazily so Node builds/tests do not require the
Python SDK. A missing SDK becomes a structured SDK_NOT_INSTALLED bridge error.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import sys
import time
from typing import Any


PROTOCOL_VERSION = 1

sessions: dict[str, dict[str, Any]] = {}
active_tasks: dict[str, dict[str, Any]] = {}
stdout_lock = asyncio.Lock()


def _setup_logging(level: str | None = None) -> None:
  logging.basicConfig(
      level=getattr(logging, (level or "INFO").upper(), logging.INFO),
      stream=sys.stderr,
      format="[a2a-antigravity-bridge] %(levelname)s %(message)s",
  )


async def emit(event: dict[str, Any]) -> None:
  async with stdout_lock:
    sys.stdout.write(json.dumps(event, separators=(",", ":"), default=str) + "\n")
    sys.stdout.flush()


async def ack(request_id: str, ok: bool = True, **kwargs: Any) -> None:
  payload = {"kind": "ack", "requestId": request_id, "ok": ok}
  payload.update(kwargs)
  await emit(payload)


def _sdk():
  try:
    from google.antigravity import Agent
    from google.antigravity.connections.local.local_connection_config import (
        LocalAgentConfig,
    )
    from google.antigravity import types
    from google.antigravity.hooks import policy
  except Exception as exc:  # pragma: no cover - depends on host Python env
    raise RuntimeError(
        "SDK_NOT_INSTALLED: Install google-antigravity in the Python environment "
        "used by antigravity.pythonPath."
    ) from exc
  return Agent, LocalAgentConfig, types, policy


def _omit_none(data: dict[str, Any]) -> dict[str, Any]:
  return {k: v for k, v in data.items() if v is not None}


def _dump(obj: Any) -> Any:
  if obj is None or isinstance(obj, (str, int, float, bool)):
    return obj
  if isinstance(obj, bytes):
    return obj.decode("utf-8", errors="replace")
  if isinstance(obj, (list, tuple, set)):
    return [_dump(v) for v in obj]
  if isinstance(obj, dict):
    return {str(k): _dump(v) for k, v in obj.items()}
  if hasattr(obj, "model_dump"):
    return _dump(obj.model_dump(mode="json", exclude_none=True))
  if hasattr(obj, "value"):
    return getattr(obj, "value")
  return str(obj)


def _build_capabilities(types: Any, cfg: dict[str, Any] | None) -> Any | None:
  if not cfg:
    return None
  payload = _omit_none({
      "enable_subagents": cfg.get("enableSubagents"),
      "enabled_tools": cfg.get("enabledTools"),
      "disabled_tools": cfg.get("disabledTools"),
      "compaction_threshold": cfg.get("compactionThreshold"),
  })
  return types.CapabilitiesConfig(**payload) if payload else None


def _build_policies(policy: Any, cfg: dict[str, Any] | None) -> list[Any] | None:
  mode = (cfg or {}).get("mode", "sdkDefault")
  if mode == "sdkDefault" or mode is None:
    return None
  if mode == "allowAll":
    return [policy.allow_all()]
  if mode == "denyAll":
    return [policy.deny_all()]
  if mode == "custom":
    result = []
    for rule in (cfg or {}).get("rules") or []:
      decision = rule.get("decision")
      tool = rule.get("tool")
      if not tool:
        continue
      if decision == "allow":
        result.append(policy.allow(tool))
      elif decision == "deny":
        result.append(policy.deny(tool))
    return result
  raise ValueError(f"Unsupported antigravity.policies.mode: {mode}")


def _build_mcp_servers(types: Any, mcp: dict[str, Any] | None) -> list[Any] | None:
  if not mcp:
    return None
  servers = []
  for name, cfg in mcp.items():
    if cfg.get("enabled") is False:
      continue
    server_type = cfg.get("type")
    common = _omit_none({
        "name": name,
        "timeout_seconds": cfg.get("timeoutSeconds"),
        "enabled_tools": cfg.get("enabledTools"),
        "disabled_tools": cfg.get("disabledTools"),
    })
    if server_type == "stdio":
      servers.append(types.McpStdioServer(**_omit_none({
          **common,
          "command": cfg.get("command"),
          "args": cfg.get("args") or [],
          "env": cfg.get("env"),
      })))
    elif server_type == "http":
      servers.append(types.McpStreamableHttpServer(**_omit_none({
          **common,
          "url": cfg.get("url"),
          "headers": cfg.get("headers"),
          "timeout": cfg.get("timeoutSeconds"),
          "sse_read_timeout": cfg.get("sseReadTimeoutSeconds"),
          "terminate_on_close": cfg.get("terminateOnClose"),
      })))
    else:
      raise ValueError(f"Unsupported MCP transport type for {name}: {server_type}")
  return servers or None


def _build_local_config(bridge_config: dict[str, Any]) -> Any:
  Agent, LocalAgentConfig, types, policy = _sdk()
  ag = bridge_config.get("antigravity") or {}
  provider = ag.get("provider") or {}
  auth_mode = provider.get("authMode") or "sdkDefault"

  workspaces = ag.get("workspaces")
  if not workspaces and ag.get("workingDirectory"):
    workspaces = [ag.get("workingDirectory")]

  payload = _omit_none({
      "system_instructions": ag.get("systemInstructions"),
      "capabilities": _build_capabilities(types, ag.get("capabilities")),
      "policies": _build_policies(policy, ag.get("policies")),
      "mcp_servers": _build_mcp_servers(types, bridge_config.get("mcp")),
      "workspaces": workspaces,
      "conversation_id": ag.get("conversationId"),
      "save_dir": ag.get("saveDir"),
      "app_data_dir": ag.get("appDataDir"),
      "response_schema": ag.get("responseSchema"),
      "skills_paths": ag.get("skillsPaths"),
      "model": ag.get("model"),
  })

  if auth_mode == "apiKey":
    if provider.get("apiKey"):
      payload["api_key"] = provider.get("apiKey")
  elif auth_mode == "adc":
    payload["vertex"] = True
    payload["project"] = provider.get("project")
    payload["location"] = provider.get("location")
  elif auth_mode == "sdkDefault":
    pass
  else:
    raise ValueError(f"Unsupported antigravity.provider.authMode: {auth_mode}")

  return Agent, LocalAgentConfig(**payload)


async def handle_initialize(msg: dict[str, Any]) -> None:
  _setup_logging(((msg.get("config") or {}).get("logLevel")))
  _sdk()
  await ack(msg["id"])


async def handle_open_session(msg: dict[str, Any]) -> None:
  request_id = msg["id"]
  session_id = msg["sessionId"]
  try:
    Agent, config = _build_local_config(msg.get("config") or {})
    agent = Agent(config)
    await agent.__aenter__()
    sessions[session_id] = {
        "agent": agent,
        "config": config,
        "lock": asyncio.Lock(),
    }
    await ack(request_id)
    await emit({
        "kind": "session_opened",
        "sessionId": session_id,
        "conversationId": agent.conversation_id,
    })
  except Exception as exc:
    await ack(
        request_id,
        False,
        code=_error_code(exc),
        message=_error_message(exc),
        details=_error_details(exc),
    )


async def handle_run(msg: dict[str, Any]) -> None:
  task_id = msg["taskId"]
  session_id = msg["sessionId"]
  await ack(msg["id"])

  task = asyncio.create_task(_run_task(task_id, session_id, msg.get("prompt") or ""))
  active_tasks[task_id] = {"task": task, "response": None, "sessionId": session_id}


async def _run_task(task_id: str, session_id: str, prompt: str) -> None:
  session = sessions.get(session_id)
  if not session:
    await emit({
        "kind": "failed",
        "taskId": task_id,
        "code": "SESSION_NOT_FOUND",
        "message": f"Unknown Antigravity session: {session_id}",
    })
    return

  started = time.monotonic()
  response = None
  text_parts: list[str] = []

  try:
    async with session["lock"]:
      response = await session["agent"].chat(prompt)
      active_tasks[task_id]["response"] = response

      async for chunk in response.chunks:
        cls_name = chunk.__class__.__name__
        if cls_name == "Text":
          text = getattr(chunk, "text", "")
          if text:
            text_parts.append(text)
            await emit({"kind": "text_delta", "taskId": task_id, "text": text})
        elif cls_name == "Thought":
          text = getattr(chunk, "text", "")
          if text:
            await emit({"kind": "thought_delta", "taskId": task_id, "text": text})
        elif hasattr(chunk, "name") and hasattr(chunk, "args"):
          await emit({
              "kind": "tool_call_start",
              "taskId": task_id,
              "toolName": str(getattr(chunk, "name", "unknown")),
              "toolId": getattr(chunk, "id", None),
              "args": _dump(getattr(chunk, "args", {})),
          })

      usage = _usage_payload(response.usage_metadata, started)
      if usage is not None:
        await emit({"kind": "usage", "taskId": task_id, "usage": usage})

      structured = await response.structured_output()
      if structured is not None:
        await emit({
            "kind": "structured_output",
            "taskId": task_id,
            "output": _dump(structured),
        })

      final_text = "".join(text_parts)
      if not final_text:
        final_text = await response.text()
      await emit({
          "kind": "completed",
          "taskId": task_id,
          "text": final_text,
          "usage": usage,
          "structuredOutput": _dump(structured) if structured is not None else None,
      })
  except asyncio.CancelledError:
    await emit({"kind": "canceled", "taskId": task_id, "message": "Canceled"})
  except Exception as exc:
    await emit({
        "kind": "failed",
        "taskId": task_id,
        "code": _error_code(exc),
        "message": _error_message(exc),
        "details": _error_details(exc),
    })
  finally:
    active_tasks.pop(task_id, None)


def _usage_payload(usage: Any, started: float) -> dict[str, Any] | None:
  if usage is None:
    return None
  data = _dump(usage)
  if not isinstance(data, dict):
    return None
  return {
      "inputTokens": data.get("prompt_token_count") or 0,
      "outputTokens": data.get("candidates_token_count") or 0,
      "cacheReadTokens": data.get("cached_content_token_count") or 0,
      "cacheWriteTokens": 0,
      "reasoningTokens": data.get("thoughts_token_count") or 0,
      "totalTokens": data.get("total_token_count") or 0,
      "durationMs": int((time.monotonic() - started) * 1000),
  }


async def handle_cancel(msg: dict[str, Any]) -> None:
  task_id = msg["taskId"]
  active = active_tasks.get(task_id)
  if active and active.get("response") is not None:
    with contextlib.suppress(Exception):
      await active["response"].cancel()
  if active:
    active["task"].cancel()
  await ack(msg["id"])


async def handle_close_session(msg: dict[str, Any]) -> None:
  session = sessions.pop(msg["sessionId"], None)
  if session:
    with contextlib.suppress(Exception):
      await session["agent"].__aexit__(None, None, None)
  await ack(msg["id"])


async def handle_shutdown(msg: dict[str, Any]) -> None:
  for session_id in list(sessions.keys()):
    session = sessions.pop(session_id)
    with contextlib.suppress(Exception):
      await session["agent"].__aexit__(None, None, None)
  await ack(msg["id"])


def _error_code(exc: BaseException) -> str:
  text = str(exc)
  if text.startswith("SDK_NOT_INSTALLED"):
    return "SDK_NOT_INSTALLED"
  if "API key" in text or "Unauthenticated" in text or "401" in text:
    return "AUTH_ERROR"
  if "ValidationError" in exc.__class__.__name__ or "validation" in text.lower():
    return "CONFIG_VALIDATION_ERROR"
  if isinstance(exc, asyncio.CancelledError):
    return "CANCELED"
  return exc.__class__.__name__.upper()


def _error_message(exc: BaseException) -> str:
  text = str(exc) or exc.__class__.__name__
  if text.startswith("SDK_NOT_INSTALLED: "):
    return text.split(": ", 1)[1]
  return text


def _error_details(exc: BaseException) -> Any:
  errors = getattr(exc, "errors", None)
  if callable(errors):
    with contextlib.suppress(Exception):
      return errors()
  return None


async def dispatch(msg: dict[str, Any]) -> None:
  if msg.get("protocolVersion") != PROTOCOL_VERSION:
    await ack(
        msg.get("id", ""),
        False,
        code="BRIDGE_PROTOCOL_ERROR",
        message=f"Unsupported protocolVersion: {msg.get('protocolVersion')}",
    )
    return

  command = msg.get("command")
  if command == "initialize":
    await handle_initialize(msg)
  elif command == "open_session":
    await handle_open_session(msg)
  elif command == "run":
    await handle_run(msg)
  elif command == "cancel":
    await handle_cancel(msg)
  elif command == "close_session":
    await handle_close_session(msg)
  elif command == "shutdown":
    await handle_shutdown(msg)
  else:
    await ack(
        msg.get("id", ""),
        False,
        code="BRIDGE_PROTOCOL_ERROR",
        message=f"Unknown command: {command}",
    )


async def read_stdin() -> None:
  loop = asyncio.get_running_loop()
  while True:
    line = await loop.run_in_executor(None, sys.stdin.readline)
    if not line:
      break
    try:
      msg = json.loads(line)
      await dispatch(msg)
    except Exception as exc:
      await emit({
          "kind": "failed",
          "code": _error_code(exc),
          "message": _error_message(exc),
          "details": _error_details(exc),
      })


def main() -> None:
  _setup_logging()
  asyncio.run(read_stdin())


if __name__ == "__main__":
  main()
