#!/usr/bin/env node
/**
 * Lightweight fake Ollama for BYOK cookouts (no GPU / no model pull).
 *
 * Speaks enough of:
 *   - OpenAI Chat Completions  POST /v1/chat/completions
 *   - OpenAI Responses         POST /v1/responses   (Copilot ↔ Ollama default)
 *   - Anthropic Messages       POST /v1/messages    (Claude Code ↔ Ollama)
 *   - Model list               GET  /v1/models, GET /api/tags
 *
 *   node examples/otel-stack/mock-ollama.mjs
 *   MOCK_OLLAMA_PORT=11434 node examples/otel-stack/mock-ollama.mjs
 *
 * Point Copilot at:  http://127.0.0.1:<port>/v1
 * Point Claude at:   ANTHROPIC_BASE_URL=http://127.0.0.1:<port>
 */

import http from "node:http";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.MOCK_OLLAMA_PORT || 11434);
const MODEL = process.env.MOCK_OLLAMA_MODEL || "mock-ollama";
const REPLY = process.env.MOCK_OLLAMA_REPLY || "pong-from-mock-ollama";

const requests = [];

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(data),
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function usage() {
  return {
    prompt_tokens: 12,
    completion_tokens: 5,
    total_tokens: 17,
    input_tokens: 12,
    output_tokens: 5,
  };
}

function chatCompletion(body, stream) {
  const id = `chatcmpl-${randomUUID().slice(0, 8)}`;
  const model = body.model || MODEL;
  if (stream) {
    return { id, model, stream: true };
  }
  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: REPLY },
        finish_reason: "stop",
      },
    ],
    usage: usage(),
  };
}

function writeChatStream(res, body) {
  const id = `chatcmpl-${randomUUID().slice(0, 8)}`;
  const model = body.model || MODEL;
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const chunk1 = {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: { role: "assistant", content: REPLY }, finish_reason: null }],
  };
  const chunk2 = {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: usage(),
  };
  res.write(`data: ${JSON.stringify(chunk1)}\n\n`);
  res.write(`data: ${JSON.stringify(chunk2)}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

function responsesApi(body) {
  const id = `resp-${randomUUID().slice(0, 8)}`;
  const model = body.model || MODEL;
  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model,
    output: [
      {
        type: "message",
        id: `msg-${randomUUID().slice(0, 8)}`,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: REPLY }],
      },
    ],
    output_text: REPLY,
    usage: {
      input_tokens: 12,
      output_tokens: 5,
      total_tokens: 17,
    },
  };
}

function writeResponsesStream(res, body) {
  const model = body.model || MODEL;
  const responseId = `resp-${randomUUID().slice(0, 8)}`;
  const itemId = `msg-${randomUUID().slice(0, 8)}`;
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const events = [
    {
      type: "response.created",
      response: { id: responseId, object: "response", status: "in_progress", model },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", id: itemId, role: "assistant", status: "in_progress", content: [] },
    },
    {
      type: "response.output_text.delta",
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      delta: REPLY,
    },
    {
      type: "response.output_text.done",
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      text: REPLY,
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "message",
        id: itemId,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: REPLY }],
      },
    },
    {
      type: "response.completed",
      response: {
        id: responseId,
        object: "response",
        status: "completed",
        model,
        output: [
          {
            type: "message",
            id: itemId,
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: REPLY }],
          },
        ],
        usage: { input_tokens: 12, output_tokens: 5, total_tokens: 17 },
      },
    },
  ];
  for (const ev of events) {
    res.write(`event: ${ev.type}\n`);
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
  }
  res.end();
}

function anthropicMessage(body, stream) {
  const id = `msg_${randomUUID().slice(0, 12)}`;
  const model = body.model || MODEL;
  if (stream) {
    return { id, model, stream: true };
  }
  return {
    id,
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text: REPLY }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 12, output_tokens: 5 },
  };
}

function writeAnthropicStream(res, body) {
  const id = `msg_${randomUUID().slice(0, 12)}`;
  const model = body.model || MODEL;
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const events = [
    {
      type: "message_start",
      message: {
        id,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        usage: { input_tokens: 12, output_tokens: 0 },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: REPLY } },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 5 },
    },
    { type: "message_stop" },
  ];
  for (const ev of events) {
    res.write(`event: ${ev.type}\n`);
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
  }
  res.end();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const path = url.pathname;
  let body = {};
  try {
    if (req.method === "POST") body = await readBody(req);
  } catch {
    return json(res, 400, { error: { message: "invalid json" } });
  }

  requests.push({
    t: new Date().toISOString(),
    method: req.method,
    path,
    model: body.model,
    stream: Boolean(body.stream),
  });
  console.log(`[mock-ollama] ${req.method} ${path}${body.model ? ` model=${body.model}` : ""}${body.stream ? " stream" : ""}`);

  // Health / discovery (Claude Code probes HEAD /api/hello)
  if (
    (req.method === "GET" || req.method === "HEAD") &&
    (path === "/" || path === "/health" || path === "/api/version" || path === "/api/hello")
  ) {
    if (req.method === "HEAD") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end();
      return;
    }
    return json(res, 200, { status: "ok", version: "0.0.0-mock", mock: true });
  }
  if (req.method === "GET" && (path === "/v1/models" || path === "/models")) {
    return json(res, 200, {
      object: "list",
      data: [{ id: MODEL, object: "model", owned_by: "mock-ollama" }],
    });
  }
  if (req.method === "GET" && path === "/api/tags") {
    return json(res, 200, {
      models: [{ name: MODEL, model: MODEL, modified_at: new Date().toISOString(), size: 1 }],
    });
  }
  if (req.method === "GET" && path === "/__mock__/requests") {
    return json(res, 200, { requests });
  }

  // OpenAI chat completions
  if (req.method === "POST" && (path === "/v1/chat/completions" || path === "/chat/completions")) {
    if (body.stream) return writeChatStream(res, body);
    return json(res, 200, chatCompletion(body, false));
  }

  // OpenAI responses (Copilot ↔ Ollama recommended wireApi)
  if (req.method === "POST" && (path === "/v1/responses" || path === "/responses")) {
    if (body.stream) return writeResponsesStream(res, body);
    return json(res, 200, responsesApi(body));
  }

  // Anthropic Messages (Claude Code ↔ Ollama)
  if (req.method === "POST" && (path === "/v1/messages" || path === "/messages")) {
    if (body.stream) return writeAnthropicStream(res, body);
    return json(res, 200, anthropicMessage(body, false));
  }

  // count_tokens sometimes probed
  if (req.method === "POST" && path.endsWith("/count_tokens")) {
    return json(res, 200, { input_tokens: 12 });
  }

  json(res, 404, { error: { message: `mock-ollama: no handler for ${req.method} ${path}` } });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[mock-ollama] listening on http://127.0.0.1:${PORT}`);
  console.log(`[mock-ollama] Copilot BYOK baseUrl: http://127.0.0.1:${PORT}/v1`);
  console.log(`[mock-ollama] Claude ANTHROPIC_BASE_URL: http://127.0.0.1:${PORT}`);
  console.log(`[mock-ollama] model=${MODEL} reply=${JSON.stringify(REPLY)}`);
});

process.on("SIGINT", () => server.close(() => process.exit(0)));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
