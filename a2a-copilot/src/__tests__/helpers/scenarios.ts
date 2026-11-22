/**
 * Scripted Copilot sessions shared by the golden parity test and the recorder that produced its fixture.
 *
 * A scenario is what the Copilot SDK would emit for one prompt, as data. The fixture
 * (`../golden/old-executor.golden.json`) was recorded by running the SAME scenarios through the executor that existed
 * before the provider migration (the `AgentExecutor` of a2a-copilot 1.8.2, on `integration/core-boundary-impl` at
 * 23d46bf) and the real SDK request handler; the parity test replays them through the provider and compares.
 */

export type Step = [event: string, data?: Record<string, unknown>];

export interface Scenario {
  name: string;
  /** `copilot.streaming`. Default true. */
  streaming?: boolean;
  streamArtifactChunks?: boolean;
  trackUsage?: boolean;
  /** Events emitted in order after the prompt is sent; `session.idle` follows. */
  steps: Step[];
  /** Non-streaming: the content `sendAndWait` resolves with (usage events in `steps` are emitted before it resolves). */
  response?: string;
  /** Make the send fail. */
  sendError?: string;
  /** Raw tool-call guard: configure a BYOK provider so the guard is active. */
  byok?: boolean;
}

const usage = (over: Record<string, unknown> = {}): Step => [
  "assistant.usage",
  { model: "gpt-4.1", inputTokens: 100, outputTokens: 40, cacheReadTokens: 10, cacheWriteTokens: 0, reasoningTokens: 5, duration: 250, timeToFirstTokenMs: 90, cost: 1, apiEndpoint: "https://api.example/v1", initiator: "agent", ...over },
];

const usageInfo: Step = ["session.usage_info", { currentTokens: 900, tokenLimit: 8000, conversationTokens: 700, systemTokens: 100, toolDefinitionsTokens: 100, messagesLength: 4 }];

const rich: Step[] = [
  ["assistant.intent", { intent: "Greeting the user" }],
  ["assistant.reasoning_delta", { deltaContent: "think " }],
  ["assistant.reasoning_delta", { deltaContent: "hard" }],
  ["assistant.reasoning", { content: "think hard" }],
  ["tool.execution_start", { toolName: "read_file" }],
  ["tool.execution_progress", { progressMessage: "reading 1/2" }],
  ["tool.execution_complete", { toolCallId: "tc1", success: true }],
  ["tool.execution_start", { mcpToolName: "secret_word" }],
  ["tool.execution_complete", { toolCallId: "tc2", success: false, error: { message: "boom" } }],
  ["subagent.started", { agentDisplayName: "Helper" }],
  ["subagent.completed", { agentName: "helper" }],
  ["subagent.started", { agentName: "other" }],
  ["subagent.failed", { agentName: "other", error: "nope" }],
  usage(),
  usage({ inputTokens: 20, outputTokens: 10, cost: 0.5, model: "claude-sonnet-4.5" }),
  usageInfo,
  ["assistant.message_delta", { deltaContent: "Hello " }],
  ["assistant.message_delta", { deltaContent: "world" }],
  ["assistant.message", { content: "Hello world" }],
];

export const SCENARIOS: Scenario[] = [
  { name: "streaming-buffered-rich", steps: rich },
  { name: "streaming-chunks-trackusage-rich", streamArtifactChunks: true, trackUsage: true, steps: rich },
  { name: "streaming-buffered-trackusage", trackUsage: true, steps: [usage(), usageInfo, ["assistant.message_delta", { deltaContent: "Hi" }]] },
  { name: "streaming-message-only-fallback", steps: [["assistant.message", { content: "from final message" }]] },
  { name: "streaming-no-text", steps: [usage()] },
  { name: "streaming-session-error", steps: [["assistant.message_delta", { deltaContent: "partial" }], ["session.error", { message: "model exploded" }]] },
  { name: "streaming-timeout-error-is-completion", steps: [["assistant.message_delta", { deltaContent: "partial" }], ["session.error", { message: "Timeout after 60000ms waiting for session.idle" }]] },
  { name: "nonstreaming-usage", streaming: false, trackUsage: true, steps: [usage(), usageInfo], response: "answer" },
  { name: "nonstreaming-chunks-no-usage", streaming: false, streamArtifactChunks: true, steps: [], response: "answer" },
  { name: "send-fails", steps: [], sendError: "ECONNREFUSED 127.0.0.1" },
  { name: "byok-raw-tool-call-guard", byok: true, steps: [["assistant.message_delta", { deltaContent: '{"name":"view","arguments":{"path":"x"}}' }]] },
];

/** The config the executor / provider is built with for a scenario. */
export function configFor(s: Scenario): any {
  return {
    agentCard: { name: "Golden Agent", description: "g" },
    server: { port: 3000, hostname: "0.0.0.0", advertiseHost: "localhost", advertiseProtocol: "http" },
    copilot: {
      cliUrl: "",
      model: "gpt-4.1",
      streaming: s.streaming !== false,
      systemPrompt: "",
      systemPromptMode: "append",
      contextFile: "context.md",
      contextPrompt: "",
      workspaceDirectory: "",
      ...(s.byok ? { provider: { baseUrl: "http://localhost:11434/v1" } } : {}),
    },
    session: { reuseByContext: true, ttl: 3_600_000, cleanupInterval: 0, titlePrefix: "A2A" },
    features: { streamArtifactChunks: s.streamArtifactChunks === true, trackUsage: s.trackUsage === true },
    timeouts: { prompt: 600_000 },
    logging: { level: "error" },
    mcp: {},
    customAgents: [],
    events: { enabled: true, transport: "a2a" },
    memory: undefined,
    configDir: undefined,
    subAgents: undefined,
  };
}

/** A fake Copilot session that plays a scenario when a prompt is sent. */
export class ScriptedSession {
  readonly sessionId: string;
  readonly sent: Array<{ prompt: string; mode?: string; clientTurnId?: string }> = [];
  private readonly handlers = new Map<string, Set<(e: unknown) => void>>();
  aborted = 0;
  disconnected = 0;

  constructor(private readonly scenario: Scenario, sessionId = "sess-golden") {
    this.sessionId = sessionId;
  }

  on(event: string, handler: (e: unknown) => void): () => void {
    let set = this.handlers.get(event);
    if (!set) this.handlers.set(event, (set = new Set()));
    set.add(handler);
    return () => void set!.delete(handler);
  }

  emit(event: string, data?: unknown): void {
    for (const h of [...(this.handlers.get(event) ?? [])]) h({ type: event, data });
  }

  private play(): void {
    for (const [event, data] of this.scenario.steps) this.emit(event, data);
  }

  async send(params: { prompt: string; mode?: string; clientTurnId?: string }): Promise<string> {
    this.sent.push(params);
    if (this.scenario.sendError) throw new Error(this.scenario.sendError);
    // A real session emits asynchronously, after send() has returned.
    queueMicrotask(() => {
      this.play();
      this.emit("session.idle");
    });
    return `msg-${this.sent.length}`;
  }

  async sendAndWait(params: { prompt: string }): Promise<{ data: { content: string } }> {
    this.sent.push(params);
    if (this.scenario.sendError) throw new Error(this.scenario.sendError);
    this.play();
    return { data: { content: this.scenario.response ?? "" } };
  }

  async abort(): Promise<void> {
    this.aborted++;
  }

  async disconnect(): Promise<void> {
    this.disconnected++;
  }

  async destroy(): Promise<void> {
    await this.disconnect();
  }
}

/** A fake Copilot client over scripted sessions. */
export class FakeClient {
  readonly sessions: ScriptedSession[] = [];
  readonly createOptions: Array<Record<string, unknown>> = [];
  readonly resumeCalls: Array<{ id: string; options: Record<string, unknown> }> = [];
  started = 0;
  stopped = 0;
  /** Session ids `resumeSession` knows. */
  known = new Set<string>();
  private nextId = 1;

  constructor(private readonly scenario: Scenario | (() => Scenario)) {}

  private scenarioNow(): Scenario {
    return typeof this.scenario === "function" ? this.scenario() : this.scenario;
  }

  async start(): Promise<void> {
    this.started++;
  }

  async stop(): Promise<unknown[]> {
    this.stopped++;
    return [];
  }

  async createSession(options: Record<string, unknown>): Promise<ScriptedSession> {
    this.createOptions.push(options);
    const s = new ScriptedSession(this.scenarioNow(), `sess-${this.nextId++}`);
    this.sessions.push(s);
    this.known.add(s.sessionId);
    return s;
  }

  async resumeSession(id: string, options: Record<string, unknown>): Promise<ScriptedSession> {
    this.resumeCalls.push({ id, options });
    if (!this.known.has(id)) throw new Error(`Session not found: ${id}`);
    const s = new ScriptedSession(this.scenarioNow(), id);
    this.sessions.push(s);
    return s;
  }

  async getSessionMetadata(id: string): Promise<unknown | undefined> {
    return this.known.has(id) ? { sessionId: id } : undefined;
  }
}
