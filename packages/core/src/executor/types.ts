/**
 * @module executor/types
 *
 * Defines the {@link A2AExecutor} interface — the contract that every wrapper
 * project's executor must satisfy in order to plug into the shared A2A server
 * infrastructure provided by `@a2a-wrapper/core`.
 *
 * The interface is structurally compatible with the `AgentExecutor` type
 * exported by `@a2a-js/sdk/server`, so implementations can be passed directly
 * to `DefaultRequestHandler` without an adapter layer. It extends the SDK
 * contract with lifecycle hooks (`initialize`, `shutdown`) and optional
 * context-file operations (`getContextContent`, `buildContext`) that are
 * common across all current wrapper projects.
 *
 * @example
 * ```typescript
 * import type { A2AExecutor } from "@a2a-wrapper/core";
 *
 * class MyExecutor implements A2AExecutor {
 *   async initialize() { // connect to backend }
 *   async shutdown()    { // release resources  }
 *   async execute(ctx, bus) { // handle A2A task }
 * }
 * ```
 *
 * @see {@link https://github.com/a2a-js/a2a-js | @a2a-js/sdk} for the
 *   upstream `AgentExecutor` and `RequestContext` definitions.
 */

import type { RequestContext, ExecutionEventBus } from "@a2a-js/sdk/server";

/**
 * Contract that every wrapper project's executor must satisfy.
 *
 * `A2AExecutor` is the single integration point between the shared server
 * infrastructure (`createA2AServer`, `createCli`) and the backend-specific
 * logic each wrapper project provides. Implementations are responsible for:
 *
 * 1. **Lifecycle** — allocating and releasing backend resources via
 *    {@link initialize} and {@link shutdown}.
 * 2. **Task execution** — translating an inbound A2A request into backend
 *    calls and publishing progress / artifact events via {@link execute}.
 * 3. **Cancellation** *(optional)* — aborting a running task when the client
 *    sends a cancel request via {@link cancelTask}.
 * 4. **Context management** *(optional)* — reading or building a domain
 *    context file that enriches the backend's system prompt via
 *    {@link getContextContent} and {@link buildContext}.
 *
 * The `execute` and `cancelTask` signatures are intentionally identical to
 * those on `AgentExecutor` from `@a2a-js/sdk/server`, ensuring that any
 * `A2AExecutor` instance (with `cancelTask` implemented) is structurally
 * assignable to the SDK type and can be passed directly to
 * `DefaultRequestHandler`.
 *
 * @remarks
 * CMMI Level 5 — This interface is the primary extension point for new
 * wrapper projects. Adding a new backend requires only implementing this
 * interface; no changes to `@a2a-wrapper/core` are necessary.
 */
export interface A2AExecutor {
  /**
   * Perform asynchronous startup logic.
   *
   * Called once by the server factory after the executor is constructed and
   * before the HTTP server begins accepting requests. Typical work includes
   * establishing backend connections, running health checks, registering MCP
   * servers, and pre-loading configuration or context files.
   *
   * @returns A promise that resolves when the executor is fully ready to
   *   handle requests. The server will not start listening until this
   *   promise settles.
   *
   * @throws If initialization fails, the promise should reject with a
   *   descriptive error. The server factory will propagate the error and
   *   prevent the server from starting.
   */
  initialize(): Promise<void>;

  /**
   * Release all resources held by the executor.
   *
   * Called once during graceful shutdown (SIGINT / SIGTERM) after the HTTP
   * server has stopped accepting new connections. Implementations should
   * close backend connections, cancel in-flight requests, stop timers, and
   * perform any other cleanup necessary to avoid resource leaks.
   *
   * @returns A promise that resolves when all resources have been released.
   */
  shutdown(): Promise<void>;

  /**
   * Execute an A2A task request.
   *
   * This is the core method required by the `@a2a-js/sdk/server`
   * `AgentExecutor` interface. The server framework calls it for every
   * inbound `message/send` or `message/stream` JSON-RPC request.
   *
   * Implementations should:
   * 1. Extract the user message and any reference tasks from `ctx`.
   * 2. Forward the request to the backend system.
   * 3. Publish progress status events and artifact events on `bus` as
   *    results arrive from the backend.
   * 4. Publish a final status event (`completed`, `failed`, or `canceled`)
   *    before the returned promise resolves.
   *
   * @param ctx - The request context containing the user message, task ID,
   *   context ID, and optional reference tasks. Provided by the A2A SDK's
   *   `DefaultRequestHandler`.
   * @param bus - The event bus for publishing `TaskStatusUpdateEvent` and
   *   `TaskArtifactUpdateEvent` instances back to the client.
   *
   * @returns A promise that resolves when execution is complete and all
   *   events have been published.
   */
  execute(ctx: RequestContext, bus: ExecutionEventBus): Promise<void>;

  /**
   * Cancel a running task.
   *
   * Called when the client sends a `tasks/cancel` JSON-RPC request.
   * Implementations should abort any in-flight backend work for the given
   * task and publish a final `canceled` status event on the bus.
   *
   * This method is optional. If not implemented, the server will report
   * that cancellation is not supported for the task.
   *
   * @param taskId - The unique identifier of the task to cancel.
   * @param bus - The event bus for publishing the final `canceled` status
   *   event.
   *
   * @returns A promise that resolves once cancellation is complete and the
   *   status event has been published.
   */
  cancelTask?(taskId: string, bus: ExecutionEventBus): Promise<void>;

  /**
   * Read the pre-built domain context file content.
   *
   * Returns the current contents of the context file that was previously
   * generated by {@link buildContext}, or `null` if no context file exists.
   * The server factory exposes this via the `GET /context` route so that
   * clients can inspect the active context.
   *
   * This method is optional. Executors that do not support context files
   * may omit it entirely.
   *
   * @returns A promise resolving to the context file content as a string,
   *   or `null` if no context file is available.
   */
  getContextContent?(): Promise<string | null>;

  /**
   * Build or refresh the domain context file.
   *
   * Generates a context file that enriches the backend's system prompt with
   * domain-specific knowledge (e.g., repository structure, API docs). The
   * server factory exposes this via the `POST /context/build` route.
   *
   * This method is optional. Executors that do not support context building
   * may omit it entirely.
   *
   * @param prompt - An optional prompt or instruction to guide context
   *   generation. When omitted, the executor should use its default
   *   context-building strategy.
   *
   * @returns A promise resolving to the generated context content as a
   *   string.
   */
  buildContext?(prompt?: string): Promise<string>;
}
