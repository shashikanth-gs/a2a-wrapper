# =============================================================================
# a2a-wrapper-gh-copilot — GitHub Copilot A2A Wrapper
# =============================================================================
#
# Multi-stage build: TypeScript compile → lean runtime image.
#
# Build:
#   docker build -t a2a-gh-copilot:latest .
#
# Run (with an agent config):
#   docker run -p 3000:3000 \
#     -e GITHUB_TOKEN=<your-token> \
#     a2a-gh-copilot:latest --config agents/example/config.json
#
# Override the agent config at runtime via the CMD or by mounting a volume:
#   docker run -p 3000:3000 \
#     -v /host/path/my-agent:/app/agents/my-agent \
#     -e GITHUB_TOKEN=<your-token> \
#     a2a-gh-copilot:latest --config agents/my-agent/config.json
#
# Environment variables (all optional except GITHUB_TOKEN in headless mode):
#   GITHUB_TOKEN       GitHub PAT for headless auth (required when gh CLI is absent)
#   COPILOT_MODEL      Override the default model (e.g. gpt-4.1)
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

LABEL org.opencontainers.image.title="A2A GitHub Copilot Wrapper" \
      org.opencontainers.image.description="A2A protocol wrapper for the GitHub Copilot SDK" \
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

# Make local node_modules binaries (e.g. the Copilot CLI stub) available.
ENV PATH="/app/node_modules/.bin:$PATH"

# Run as a non-root user for security.
# If you are running on OpenShift (arbitrary UIDs), remove this line and
# ensure the /app directory is group-writable (chgrp 0 /app && chmod g=u /app).
USER node

ENTRYPOINT ["/app/entrypoint.sh"]

# Default: start the minimal example agent.
# Override by passing --config <path> as CMD arguments.
CMD ["--config", "agents/example/config.json"]
