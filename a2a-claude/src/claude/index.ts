export { ClaudeExecutor } from "./executor.js";
export { SessionManager } from "./session-manager.js";
export { EventMapper, sanitizeMessage } from "./event-mapper.js";
export { CLAUDE_BACKEND_PATHS } from "./backend-paths.js";
export { CLAUDE_CAPABILITIES } from "./capabilities.js";
export { createClaudeClient, buildQueryOptions } from "./client-factory.js";
export type { ClaudeClientLike, QueryLike, QueryOptionsLike, SDKMessageLike } from "./client-factory.js";
export { extractUserText } from "./prompt-builder.js";
