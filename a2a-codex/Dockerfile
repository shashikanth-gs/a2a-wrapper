# =============================================================================
# a2a-codex — OpenAI Codex A2A Wrapper
# =============================================================================
#
# IMPORTANT: Build from the MONOREPO ROOT, not from this directory.
#
# Build:
#   docker build -f a2a-codex/Dockerfile -t a2a-codex:latest .
#
# The build context must be the monorepo root so that @a2a-wrapper/core is
# resolved via workspace linking rather than the npm registry.
#
# ---------------------------------------------------------------------------
# Authentication — choose ONE of the two approaches below:
# ---------------------------------------------------------------------------
#
# Option A — OpenAI API key (recommended for CI / cloud / team deployments):
#   docker run -p 3020:3020 \
#     -e OPENAI_API_KEY=<your-key> \
#     -e WORKSPACE_DIR=/workspace \
#     -v /host/path/to/repo:/workspace \
#     a2a-codex:latest
#
# Option B — ChatGPT subscription (you have already run `codex login` locally):
#   Mount your local Codex credential store read-only into the container.
#   The codex CLI looks for credentials in ~/.codex/auth.json; inside the
#   container the node user's home is /home/node.
#
#   docker run -p 3020:3020 \
#     -e WORKSPACE_DIR=/workspace \
#     -e CODEX_MODEL=gpt-5.5 \
#     -v ~/.codex:/home/node/.codex:ro \
#     -v /host/path/to/repo:/workspace \
#     a2a-codex:latest
#
#   Note: OAuth tokens in auth.json expire (typically after a few hours). The
#   CLI cannot refresh them from inside a read-only mount. Re-run `codex login`
#   on your host when the container starts returning auth errors.
#   For long-running deployments, Option A (API key) is more reliable.
#
# ---------------------------------------------------------------------------
# Override the agent config at runtime by mounting a custom config:
#   docker run -p 3020:3020 \
#     -e OPENAI_API_KEY=<your-key> \
#     -v /host/path/my-agent:/app/agents/my-agent \
#     -v /host/path/to/repo:/workspace \
#     a2a-codex:latest --config agents/my-agent/config.json
#
# Environment variables:
#   OPENAI_API_KEY   OpenAI API key (Option A auth)
#   WORKSPACE_DIR    Absolute path to the Git repository inside the container (required)
#   CODEX_MODEL      Override the model (e.g. gpt-5.5, o4-mini, o3)
#   PORT             A2A server port (default: from config, fallback 3020)
#   LOG_LEVEL        debug | info | warn | error (default: info)
#   ADVERTISE_HOST   Hostname embedded in agent card URLs (default: localhost)
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
COPY a2a-codex/package.json ./a2a-codex/

# Install with workspace linking so @a2a-wrapper/core resolves to the local
# packages/core directory rather than the published npm version.
RUN npm ci

# Copy TypeScript source for both packages.
COPY packages/core/src ./packages/core/src
COPY packages/core/tsconfig.json ./packages/core/
COPY a2a-codex/src ./a2a-codex/src
COPY a2a-codex/tsconfig.json ./a2a-codex/

# Build core first — codex depends on it at compile time.
RUN npm run build -w @a2a-wrapper/core

# Build the codex wrapper.
RUN npm run build -w a2a-codex

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

# The bundled Codex CLI binary (musl-linked Rust) needs system CA certificates
# to establish TLS connections to the OpenAI/ChatGPT API. node:20-slim omits
# the ca-certificates package by default.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

LABEL org.opencontainers.image.title="A2A OpenAI Codex Wrapper" \
      org.opencontainers.image.description="A2A protocol wrapper for the OpenAI Codex SDK" \
      org.opencontainers.image.version="0.1.0" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app

# Copy the compiled output and self-contained node_modules from the builder.
COPY --from=builder /monorepo/a2a-codex/dist ./dist
COPY --from=builder /monorepo/node_modules ./node_modules
COPY --from=builder /monorepo/a2a-codex/package.json ./

# Bundle the example agents so the image is runnable out of the box.
COPY a2a-codex/agents/ ./agents/

COPY a2a-codex/entrypoint.sh /app/entrypoint.sh
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
