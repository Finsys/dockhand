# Build stage - using Debian to avoid Alpine musl thread creation issues
# Alpine's musl libc causes rayon/tokio thread pool panics during svelte-adapter-bun build
FROM oven/bun:1.3.5-debian AS builder

WORKDIR /app

# Install build dependencies
RUN apt-get update && apt-get install -y --no-install-recommends jq git && rm -rf /var/lib/apt/lists/*

# Copy package files and install ALL dependencies (needed for build)
COPY package.json bun.lock* bunfig.toml ./
RUN bun install --frozen-lockfile

# Copy source code and build
COPY . .

# Build with parallelism - dedicated build VM has 16 CPUs and 32GB RAM
# Increased memory limits for parallel compilation with larger semi-space for GC
RUN NODE_OPTIONS="--max-old-space-size=8192 --max-semi-space-size=128" bun run build

# Production stage - minimal Alpine with Bun runtime
FROM oven/bun:1.3.5-alpine

WORKDIR /app

# Install runtime dependencies, create user
# Add sqlite for emergency scripts, git for stack git operations, curl for healthchecks
# Add docker-cli and docker-cli-compose for stack management (uses host's docker socket)
# Add openssh-client for SSH key authentication with git repositories
# Upgrade all packages to latest versions for security patches
RUN apk upgrade --no-cache \
    && apk add --no-cache curl git tini su-exec sqlite docker-cli docker-cli-compose openssh-client iproute2 \
    && addgroup -g 1001 dockhand \
    && adduser -u 1001 -G dockhand -h /home/dockhand -D dockhand

# Copy package files and install production dependencies
# This is needed because svelte-adapter-bun externalizes some packages (croner, etc.)
# that need to be available at runtime. Installing at build time is more reliable
# than Bun's auto-install which requires network access and writable cache.
COPY package.json bun.lock* ./
RUN bun install --production --frozen-lockfile

# Copy built application (Bun adapter output)
COPY --from=builder /app/build ./build

# Copy bundled subprocess scripts (built by scripts/build-subprocesses.ts)
COPY --from=builder /app/build/subprocesses/ ./subprocesses/

# Copy database migrations
COPY drizzle/ ./drizzle/
COPY drizzle-pg/ ./drizzle-pg/

# Copy legal documents
COPY LICENSE.txt PRIVACY.txt ./

# Copy entrypoint script
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Copy emergency scripts (only the emergency subfolder, not license generation scripts)
COPY scripts/emergency/ ./scripts/
RUN chmod +x ./scripts/*.sh ./scripts/**/*.sh 2>/dev/null || true

# Create directories with proper ownership
RUN mkdir -p /home/dockhand/.dockhand/stacks /app/data \
    && chown -R dockhand:dockhand /app /home/dockhand

EXPOSE 3000

# Runtime configuration
ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV DATA_DIR=/app/data
ENV HOME=/home/dockhand

# User/group IDs - customize with -e PUID=1000 -e PGID=1000
# The entrypoint will recreate the dockhand user with these IDs
ENV PUID=1001
ENV PGID=1001

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3000/ || exit 1

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["bun", "run", "./build/index.js"]
