/**
 * Event Transport Abstraction
 *
 * Provides a pluggable transport layer for sideband observability events
 * (MCP tool calls, agent reasoning, lifecycle events). This decouples
 * event emission from A2A protocol internals, allowing consumers to route
 * trace data to any backend — HTTP endpoints, databases, message queues —
 * without adding dependencies to the core package.
 *
 * ### Built-in transports (zero dependencies)
 *
 * | Transport | Description |
 * |-----------|-------------|
 * | `a2a`     | Publish trace artifacts on the A2A {@link ExecutionEventBus} (default) |
 * | `http`    | POST events as JSON to a configurable HTTP endpoint with custom headers |
 *
 * ### Custom transports (programmatic API)
 *
 * Users who call `createA2AServer()` programmatically can supply any object
 * or function satisfying the {@link EventTransport} interface. This enables
 * Kafka, Redis, database, or any custom sink — they bring their own deps.
 *
 * ```typescript
 * createA2AServer(config, executorFactory, {
 *   eventTransport: async (event) => {
 *     await myKafkaProducer.send({ topic: "traces", messages: [{ value: JSON.stringify(event) }] });
 *   },
 * });
 * ```
 *
 * @module events/transport
 */

import { v4 as uuidv4 } from "uuid";
import type { TaskArtifactUpdateEvent } from "@a2a-js/sdk";
import type { ExecutionEventBus } from "@a2a-js/sdk/server";
import type { EventsConfig } from "../config/types.js";
import { TRACE_EXTENSION_URI } from "../server/agent-card.js";

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Event types emitted during agent execution.
 *
 * Matches the Python `agent-base` EventType enum for cross-language
 * consistency in mixed-language deployments.
 */
export type EventType =
  | "tool_call_start"
  | "tool_call_end"
  | "thinking"
  | "decision"
  | "agent_started"
  | "agent_finished"
  | "agent_error"
  | "context_window";

/**
 * A single agent event carrying structured trace data.
 *
 * Every event is stamped with agent identity, trace context, and a
 * monotonic timestamp so that consumers can correlate events across
 * distributed agent hierarchies.
 */
export interface AgentEvent {
  /** Globally unique event identifier (UUID v4). */
  eventId: string;
  /** Discriminator indicating the kind of event. */
  eventType: EventType;
  /** Unique identifier of the agent that produced this event. */
  agentId: string;
  /** Human-readable name of the producing agent. */
  agentName: string;
  /** Top-level trace/analysis identifier propagated from the orchestrator. */
  traceId: string;
  /** Identifier of the parent agent, if this is a delegated sub-agent. */
  parentAgentId?: string | null;
  /** ISO 8601 timestamp of when the event was produced. */
  timestamp: string;
  /** Event-type-specific structured payload. */
  data: Record<string, unknown>;
}

/**
 * Transport interface for delivering agent events to a sink.
 *
 * Implement this interface with a class or object for complete control,
 * or pass a plain async function — both forms are accepted by the factory.
 */
export interface EventTransport {
  send(event: AgentEvent): Promise<void>;
}

/**
 * Convenience type: a plain async function that accepts an {@link AgentEvent}.
 *
 * Accepted anywhere an {@link EventTransport} is expected. Internally
 * wrapped in an adapter that delegates to the function.
 */
export type EventTransportFn = (event: AgentEvent) => Promise<void>;

// ─── Built-in Transport Implementations ──────────────────────────────────────

/**
 * A2A sideband transport — publishes trace artifacts on the
 * {@link ExecutionEventBus} so they flow through the A2A protocol alongside
 * normal response artifacts.
 *
 * This is the default transport and requires no external dependencies.
 * Orchestrators discover trace artifacts via the `urn:x-a2a:trace:v1`
 * extension URI declared in the agent card.
 */
export class A2ATransport implements EventTransport {
  constructor(
    private readonly bus: ExecutionEventBus,
    private readonly taskId: string,
    private readonly contextId: string,
  ) {}

  async send(event: AgentEvent): Promise<void> {
    const traceKey = EVENT_TO_TRACE_KEY[event.eventType];
    if (!traceKey) return; // unmapped event types are silently dropped

    // Build structured data payload with agent identity
    const data: Record<string, unknown> = {
      agent_id: event.agentId,
      agent_name: event.agentName,
      trace_id: event.traceId,
    };
    const state = LIFECYCLE_STATE[event.eventType];
    if (state) data.state = state;
    Object.assign(data, event.data);

    const artifactEvent: TaskArtifactUpdateEvent = {
      kind: "artifact-update",
      taskId: this.taskId,
      contextId: this.contextId,
      append: false,
      lastChunk: true,
      artifact: {
        artifactId: `${traceKey}-${uuidv4()}`,
        name: traceKey,
        extensions: [TRACE_EXTENSION_URI],
        metadata: {
          traceType: traceKey,
          timestamp: event.timestamp,
        },
        parts: [
          {
            kind: "data",
            data,
            metadata: { mimeType: "application/json" },
          } as any,
        ],
      },
    };
    this.bus.publish(artifactEvent);
  }
}

/**
 * HTTP transport — POST events as JSON to a collector endpoint.
 *
 * Supports custom headers for authentication (Bearer tokens, API keys).
 * Uses the built-in `fetch` API (Node 18+), so no extra dependencies.
 */
export class HttpTransport implements EventTransport {
  constructor(
    private readonly url: string,
    private readonly timeout = 10_000,
    private readonly headers: Record<string, string> = {},
  ) {}

  async send(event: AgentEvent): Promise<void> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeout);
      const resp = await fetch(this.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...this.headers },
        body: JSON.stringify(event),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!resp.ok) {
        // Best-effort logging — transports should not throw for non-critical failures
        console.warn(`[transport:http] POST failed: ${resp.status} ${resp.statusText}`);
      }
    } catch (e) {
      console.warn(`[transport:http] POST error: ${(e as Error).message}`);
    }
  }
}

/** Null transport — silently drops all events. Used when events are disabled. */
class NullTransport implements EventTransport {
  async send(): Promise<void> {}
}

/** Wraps a plain function as an {@link EventTransport} object. */
class FunctionTransport implements EventTransport {
  constructor(private readonly fn: EventTransportFn) {}

  async send(event: AgentEvent): Promise<void> {
    await this.fn(event);
  }
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** Maps EventType → A2A trace artifact key. */
const EVENT_TO_TRACE_KEY: Record<string, string> = {
  tool_call_start: "trace.mcp.start",
  tool_call_end: "trace.mcp",
  thinking: "trace.thinking",
  decision: "trace.decision",
  agent_started: "trace.lifecycle",
  agent_finished: "trace.lifecycle",
  agent_error: "trace.lifecycle",
};

/** Maps lifecycle EventType → state string. */
const LIFECYCLE_STATE: Record<string, string> = {
  agent_started: "started",
  agent_finished: "finished",
  agent_error: "error",
};

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Normalize a transport function or object into an {@link EventTransport}.
 *
 * Accepts either:
 * - An object with a `send()` method ({@link EventTransport})
 * - A plain async function ({@link EventTransportFn})
 *
 * @returns An {@link EventTransport} instance.
 */
export function wrapTransport(
  transport: EventTransport | EventTransportFn,
): EventTransport {
  if (typeof transport === "function") {
    return new FunctionTransport(transport);
  }
  return transport;
}

/**
 * Create a built-in transport from JSON config.
 *
 * Only supports `"a2a"` and `"http"`. For A2A transport, the per-request
 * `bus`, `taskId`, and `contextId` are **not** available at config time —
 * use {@link resolveTransport} inside the executor's `execute()` method.
 *
 * @throws {Error} When `transport` is `"http"` and `httpUrl` is missing.
 */
export function createTransport(cfg: EventsConfig): EventTransport {
  if (cfg.enabled === false) return new NullTransport();

  const type = (cfg.transport ?? "a2a").toLowerCase();

  switch (type) {
    case "http": {
      if (!cfg.httpUrl) {
        throw new Error("events.httpUrl is required when transport is 'http'");
      }
      return new HttpTransport(cfg.httpUrl, cfg.httpTimeout ?? 10_000, cfg.httpHeaders ?? {});
    }
    case "a2a":
      // A2A requires per-request bus — this path is only hit when
      // createTransport is called outside of an execution context.
      console.warn("[transport] createTransport('a2a') called without bus context. Use resolveTransport() in the executor.");
      return new NullTransport();
    default:
      throw new Error(`Unknown built-in transport: "${type}". Supported: "a2a", "http". For custom transports, use the programmatic API.`);
  }
}

/**
 * Resolve the correct transport for a single task execution.
 *
 * Called inside the executor's `execute()` method where the per-request
 * `ExecutionEventBus`, `taskId`, and `contextId` are available.
 *
 * Priority:
 * 1. If a custom {@link EventTransport} or function was supplied
 *    programmatically, it wins.
 * 2. If JSON config specifies `"http"`, create an {@link HttpTransport}.
 * 3. Default: create an {@link A2ATransport} wired to the per-request bus.
 *
 * @param cfg       - Events config from the resolved agent configuration.
 * @param bus       - The per-request A2A ExecutionEventBus.
 * @param taskId    - The current A2A task identifier.
 * @param contextId - The current A2A context identifier.
 * @param custom    - Optional custom transport supplied via programmatic API.
 * @returns An {@link EventTransport} ready to accept events.
 */
export function resolveTransport(
  cfg: EventsConfig | undefined,
  bus: ExecutionEventBus,
  taskId: string,
  contextId: string,
  custom?: EventTransport | EventTransportFn,
): EventTransport {
  const eventsConfig = cfg ?? {};
  if (eventsConfig.enabled === false) return new NullTransport();

  // Programmatic custom transport takes priority
  if (custom) return wrapTransport(custom);

  const type = (eventsConfig.transport ?? "a2a").toLowerCase();

  if (type === "http") {
    if (!eventsConfig.httpUrl) {
      throw new Error("events.httpUrl is required when transport is 'http'");
    }
    return new HttpTransport(
      eventsConfig.httpUrl,
      eventsConfig.httpTimeout ?? 10_000,
      eventsConfig.httpHeaders ?? {},
    );
  }

  // Default: A2A sideband
  return new A2ATransport(bus, taskId, contextId);
}

// ─── Agent Event Emitter ─────────────────────────────────────────────────────

/**
 * Per-execution event emitter.
 *
 * Stamps every event with agent identity and trace context, then delegates
 * to the resolved {@link EventTransport}. Create one instance per
 * `execute()` call and pass it to MCP hooks and other trace producers.
 *
 * @example
 * ```typescript
 * const transport = resolveTransport(config.events, bus, taskId, contextId);
 * const emitter = new AgentEventEmitter({
 *   agentId: "prometheus-agent",
 *   agentName: "Prometheus Agent",
 *   traceId: "analysis-123",
 *   transport,
 * });
 *
 * await emitter.emit("tool_call_start", { tool: "query", request: { ... } });
 * await emitter.emit("tool_call_end",   { tool: "query", response: { ... } });
 * await emitter.emit("thinking",        { content: "The CPU is at 95%..." });
 * ```
 */
export class AgentEventEmitter {
  readonly agentId: string;
  readonly agentName: string;
  readonly traceId: string;
  readonly parentAgentId: string | null;
  private readonly transport: EventTransport;

  constructor(opts: {
    agentId: string;
    agentName: string;
    traceId: string;
    parentAgentId?: string | null;
    transport: EventTransport;
  }) {
    this.agentId = opts.agentId;
    this.agentName = opts.agentName;
    this.traceId = opts.traceId;
    this.parentAgentId = opts.parentAgentId ?? null;
    this.transport = opts.transport;
  }

  /**
   * Emit a typed agent event through the configured transport.
   *
   * The event is enriched with agent identity, trace context, a unique ID,
   * and an ISO 8601 timestamp before being sent.
   *
   * @param eventType - The kind of event (e.g. `"tool_call_end"`, `"thinking"`).
   * @param data      - Event-type-specific structured payload.
   */
  async emit(eventType: EventType, data: Record<string, unknown> = {}): Promise<void> {
    const event: AgentEvent = {
      eventId: uuidv4(),
      eventType,
      agentId: this.agentId,
      agentName: this.agentName,
      traceId: this.traceId,
      parentAgentId: this.parentAgentId,
      timestamp: new Date().toISOString(),
      data,
    };
    try {
      await this.transport.send(event);
    } catch (e) {
      console.warn(`[emitter] Failed to emit ${eventType}: ${(e as Error).message}`);
    }
  }
}
