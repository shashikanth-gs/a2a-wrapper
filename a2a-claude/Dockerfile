# =============================================================================
# a2a-claude — Claude Code A2A Wrapper
# =============================================================================
#
# IMPORTANT: Build from the MONOREPO ROOT, not from this directory.
#
# Build:
#   docker build -f a2a-claude/Dockerfile -t a2a-claude:latest .
#
# The build context must be the monorepo root so that @a2a-wrapper/core is
# resolved via workspace linking rather than the npm registry.
#
# ---------------------------------------------------------------------------
# Authentication — choose ONE of the two approaches below:
# ---------------------------------------------------------------------------
#
# Option A — Anthropic API key (recommended for CI / cloud / team deployments):
#   docker run -p 3030:3030 \
#     -e ANTHROPIC_API_KEY=<your-key> \
#     -e WORKSPACE_DIR=/workspace \
#     -v /host/path/to/repo:/workspace \
#     a2a-claude:latest
#
# Option B — Claude subscription (you have already run `claude login` locally):
#   Mount your local Claude Code credential store read-only into the container.
#   The Claude Code CLI looks for credentials under ~/.claude; inside the
#   container the node user's home is /home/node.
#
#   docker run -p 3030:3030 \
#     -e WORKSPACE_DIR=/workspace \
#     -e CLAUDE_MODEL=claude-sonnet-5 \
#     -v ~/.claude:/home/node/.claude:ro \
#     -v /host/path/to/repo:/workspace \
#     a2a-claude:latest
#
#   Note: OAuth tokens under ~/.claude expire (typically after a few hours). The
#   CLI cannot refresh them from inside a read-only mount. Re-run `claude login`
#   on your host when the container starts returning auth errors.
#   For long-running deployments, Option A (API key) is more reliable.
#
# ---------------------------------------------------------------------------
# Override the agent config at runtime by mounting a custom config:
#   docker run -p 3030:3030 \
#     -e ANTHROPIC_API_KEY=<your-key> \
#     -v /host/path/my-agent:/app/agents/my-agent \
#     -v /host/path/to/repo:/workspace \
#     a2a-claude:latest --config agents/my-agent/config.json
#
# Environment variables:
#   ANTHROPIC_API_KEY   Anthropic API key (Option A auth)
#   WORKSPACE_DIR        Absolute path to the Git repository inside the container (required)
#   CLAUDE_MODEL         Override the model (e.g. claude-sonnet-5, claude-opus-4-8)
#   PORT                 A2A server port (default: from config, fallback 3030)
#   LOG_LEVEL            debug | info | warn | error (default: info)
#   ADVERTISE_HOST       Hostname embedded in agent card URLs (default: localhost)
# =============================================================================

# ---------------------------------------------------------------------------
# Stage 1 — Builder: compile TypeScript to JavaScript
# ---------------------------------------------------------------------------
FROM node:20-slim AS builder

WORKDIR /monorepo

# Copy workspace manifests first for dependency-layer caching.
# The root package.json declares npm workspaces; the root package-lock.json
# pins all deps across the monorepo (no per-package lock files).
COPY package.json package-lock.json ./
COPY packages/core/package.json ./packages/core/
COPY a2a-claude/package.json ./a2a-claude/

# Install with workspace linking so @a2a-wrapper/core resolves to the local
# packages/core directory rather than the published npm version.
RUN npm ci

# Copy TypeScript source for both packages.
COPY packages/core/src ./packages/core/src
COPY packages/core/tsconfig.json ./packages/core/
COPY a2a-claude/src ./a2a-claude/src
COPY a2a-claude/tsconfig.json ./a2a-claude/

# Build core first — claude depends on it at compile time.
RUN npm run build -w @a2a-wrapper/core

# Build the claude wrapper.
RUN npm run build -w a2a-claude

# Resolve the workspace symlink for @a2a-wrapper/core before copying to the
# runtime stage. npm workspaces creates node_modules/@a2a-wrapper/core as a
# symlink to ../../packages/core; COPY does not follow symlinks across stages,
# so we replace it with the real directory (including the compiled dist/).
RUN rm -rf node_modules/@a2a-wrapper/core && \
    cp -r packages/core node_modules/@a2a-wrapper/core

# ---------------------------------------------------------------------------
# Stage 2 — Runtime: minimal production image
# ---------------------------------------------------------------------------
FROM node:20-slim

# The bundled Claude Code CLI needs system CA certificates to establish TLS
# connections to the Anthropic API. node:20-slim omits the ca-certificates
# package by default.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

LABEL org.opencontainers.image.title="A2A Claude Code Wrapper" \
      org.opencontainers.image.description="A2A protocol wrapper for Claude Code via the Claude Agent SDK" \
      org.opencontainers.image.version="0.1.0" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app

# Copy the compiled output and self-contained node_modules from the builder.
COPY --from=builder /monorepo/a2a-claude/dist ./dist
COPY --from=builder /monorepo/node_modules ./node_modules
COPY --from=builder /monorepo/a2a-claude/package.json ./

# Bundle the example agents so the image is runnable out of the box.
COPY a2a-claude/agents/ ./agents/

COPY a2a-claude/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Make local node_modules binaries available.
ENV PATH="/app/node_modules/.bin:$PATH"

# Run as a non-root user for security.
# If running on OpenShift (arbitrary UIDs), remove this line and ensure
# /app is group-writable: chgrp 0 /app && chmod g=u /app
USER node

ENTRYPOINT ["/app/entrypoint.sh"]

# Default: start the example workspace engineer agent.
# Override by passing --config <path> as CMD arguments.
CMD ["--config", "agents/example/config.json"]
