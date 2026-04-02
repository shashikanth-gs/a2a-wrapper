# =============================================================================
# a2a-wrapper-opencode — OpenCode A2A Wrapper
# =============================================================================
#
# Multi-stage build: TypeScript compile → lean runtime image.
#
# IMPORTANT: The wrapper connects to an external OpenCode server process.
# OpenCode is NOT included in this image. Start it separately:
#   opencode serve --port 4096
# Then point the wrapper at it via the config's opencode.baseUrl field.
#
# Build:
#   docker build -t a2a-opencode:latest .
#
# Run (with an agent config and an externally running OpenCode):
#   docker run -p 3000:3000 \
#     -e OPENCODE_URL=http://host.docker.internal:4096 \
#     a2a-opencode:latest --config agents/example/config.json
#
# Override the agent config at runtime via the CMD or by mounting a volume:
#   docker run -p 3000:3000 \
#     -v /host/path/my-agent:/app/agents/my-agent \
#     a2a-opencode:latest --config agents/my-agent/config.json
#
# Environment variables (all optional):
#   OPENCODE_URL       Override the OpenCode base URL (default: from config)
#   PORT               A2A server port (default: from config, fallback 3000)
#   LOG_LEVEL          debug | info | warn | error (default: info)
#   WORKSPACE_DIR      Override the agent workspace directory
# =============================================================================

# ---------------------------------------------------------------------------
# Stage 1 — Builder: compile TypeScript to JavaScript
# ---------------------------------------------------------------------------
FROM node:18-slim AS builder

WORKDIR /app

# Install dependencies before copying source so this layer is cached
# unless package.json / package-lock.json change.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 2 — Runtime: minimal production image
# ---------------------------------------------------------------------------
FROM node:18-slim

LABEL org.opencontainers.image.title="A2A OpenCode Wrapper" \
      org.opencontainers.image.description="A2A protocol wrapper for OpenCode" \
      org.opencontainers.image.version="1.0.0" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app

# Copy only the build output and production dependencies from the builder.
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# Bundle the example agents so the image is runnable out of the box.
COPY agents/ ./agents/

COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Run as a non-root user for security.
# If you are running on OpenShift (arbitrary UIDs), remove this line and
# ensure the /app directory is group-writable (chgrp 0 /app && chmod g=u /app).
USER node

ENTRYPOINT ["/app/entrypoint.sh"]

# Default: start the minimal example agent.
# Override by passing --config <path> as CMD arguments.
CMD ["--config", "agents/example/config.json"]
