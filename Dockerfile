# syntax=docker/dockerfile:1.4
# =============================================================================
# Dockhand Docker Image - Security-Hardened Build
# =============================================================================
# This Dockerfile builds a custom Wolfi OS from scratch using apko, ensuring:
# - Full transparency (no dependency on pre-built Chainguard images)
# - Reproducible builds from open-source Wolfi packages
# - Minimal attack surface with only required packages
#
# Bun is copied from the official oven/bun image (app-builder stage).
# For CPUs without AVX support (Celeron, Atom, pre-Haswell), build with:
#   docker build --build-arg BUN_VARIANT=baseline -t dockhand:baseline .
# =============================================================================

# -----------------------------------------------------------------------------
# Stage 1: OS Generator (Alpine + apko tool)
# -----------------------------------------------------------------------------
# We use Alpine because it has a shell. This lets us download and run apko
# to build our custom Wolfi OS from scratch using open-source packages.
FROM alpine:3.21 AS os-builder

ARG TARGETARCH

WORKDIR /work

# Install apko tool (latest stable release)
# apko is the tool Chainguard uses to build their images - we use it directly
ARG APKO_VERSION=0.30.34
RUN apk add --no-cache curl unzip \
    && ARCH=$([ "$TARGETARCH" = "arm64" ] && echo "arm64" || echo "amd64") \
    && curl -sL "https://github.com/chainguard-dev/apko/releases/download/v${APKO_VERSION}/apko_${APKO_VERSION}_linux_${ARCH}.tar.gz" \
       | tar -xz --strip-components=1 -C /usr/local/bin \
    && chmod +x /usr/local/bin/apko

# Generate apko.yaml for current target architecture only
# We build single-arch to avoid multi-arch layer confusion in extraction
# Note: Bun is NOT included here - it's copied from app-builder stage for CPU compatibility
RUN APKO_ARCH=$([ "$TARGETARCH" = "arm64" ] && echo "aarch64" || echo "x86_64") \
    && printf '%s\n' \
    "contents:" \
    "  repositories:" \
    "    - https://packages.wolfi.dev/os" \
    "  keyring:" \
    "    - https://packages.wolfi.dev/os/wolfi-signing.rsa.pub" \
    "  packages:" \
    "    - wolfi-base" \
    "    - ca-certificates" \
    "    - busybox" \
    "    - tzdata" \
    "    - docker-cli" \
    "    - docker-compose" \
    "    - docker-cli-buildx" \
    "    - sqlite" \
    "    - postgresql-client" \
    "    - git" \
    "    - openssh-client" \
    "    - curl" \
    "    - tini" \
    "    - su-exec" \
    "entrypoint:" \
    "  command: /bin/sh -l" \
    "archs:" \
    "  - ${APKO_ARCH}" \
    > apko.yaml

# Build the OS tarball and extract rootfs
# apko creates an OCI tarball - we need to extract the actual filesystem layer
RUN apko build apko.yaml dockhand-base:latest output.tar \
    && mkdir -p rootfs \
    && tar -xf output.tar \
    && LAYER=$(tar -tf output.tar | grep '.tar.gz$' | head -1) \
    && tar -xzf "$LAYER" -C rootfs

# -----------------------------------------------------------------------------
# Stage 2: Application Builder
# -----------------------------------------------------------------------------
# Using Debian to avoid Alpine musl thread creation issues
# Alpine's musl libc causes rayon/tokio thread pool panics during svelte-adapter-bun build
FROM oven/bun:1.3.5-debian AS app-builder

# Build argument for Bun variant (regular or baseline)
# baseline is for CPUs without AVX support (Celeron, Atom, pre-Haswell)
ARG BUN_VARIANT=regular
ARG TARGETARCH

WORKDIR /app

# Install build dependencies
RUN apt-get update && apt-get install -y --no-install-recommends jq git curl unzip ca-certificates && rm -rf /var/lib/apt/lists/*

# Copy package files and install ALL dependencies (needed for build)
COPY package.json bun.lock* bunfig.toml ./
RUN bun install --frozen-lockfile

# Copy source code and build
COPY . .

# Build with parallelism - dedicated build VM has 16 CPUs and 32GB RAM
RUN NODE_OPTIONS="--max-old-space-size=8192 --max-semi-space-size=128" bun run build

# Prepare production node_modules (do this in builder where we have compilers)
# This ensures native addons compile correctly before copying to hardened runtime
RUN rm -rf node_modules && bun install --production --frozen-lockfile \
    && rm -rf node_modules/@types node_modules/bun-types

# Download baseline Bun binary if BUN_VARIANT=baseline (for CPUs without AVX)
# Only applies to amd64 - ARM64 doesn't have AVX concept
ARG BUN_VERSION=1.3.5
RUN if [ "$BUN_VARIANT" = "baseline" ] && [ "$TARGETARCH" = "amd64" ]; then \
      echo "Downloading Bun baseline binary for CPUs without AVX support..." && \
      curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64-baseline.zip" -o /tmp/bun.zip && \
      unzip -o /tmp/bun.zip -d /tmp && \
      cp /tmp/bun-linux-x64-baseline/bun /usr/local/bin/bun && \
      chmod +x /usr/local/bin/bun && \
      rm -rf /tmp/bun.zip /tmp/bun-linux-x64-baseline && \
      echo "Bun baseline binary installed successfully"; \
    fi

# -----------------------------------------------------------------------------
# Stage 3: Final Image (Scratch + Custom Wolfi OS)
# -----------------------------------------------------------------------------
FROM scratch

# Install our custom-built Wolfi OS (now we have /bin/sh!)
COPY --from=os-builder /work/rootfs/ /

# Copy Bun from official image - ensures compatibility with all x86_64 CPUs (no AVX2 requirement)
# Wolfi's bun package requires AVX2 which breaks on Celeron/Atom CPUs
# For baseline builds (BUN_VARIANT=baseline), this contains the baseline binary (no AVX requirement)
# For regular builds, this contains the standard oven/bun binary
COPY --from=app-builder /usr/local/bin/bun /usr/bin/bun

WORKDIR /app

# Set up environment variables
ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
    NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DATA_DIR=/app/data \
    HOME=/home/dockhand \
    PUID=1001 \
    PGID=1001

# Create docker compose plugin symlink (we use `docker compose` syntax, Wolfi has standalone binary)
# Note: docker-cli-buildx package already creates the buildx symlink
RUN mkdir -p /usr/libexec/docker/cli-plugins \
    && ln -s /usr/bin/docker-compose /usr/libexec/docker/cli-plugins/docker-compose

# Create dockhand user and group (using busybox commands)
RUN addgroup -g 1001 dockhand \
    && adduser -u 1001 -G dockhand -h /home/dockhand -D dockhand

# Copy application files with correct ownership (avoids layer duplication from chown -R)
COPY --from=app-builder --chown=dockhand:dockhand /app/node_modules ./node_modules
COPY --from=app-builder --chown=dockhand:dockhand /app/package.json ./
COPY --from=app-builder --chown=dockhand:dockhand /app/build ./build
COPY --from=app-builder --chown=dockhand:dockhand /app/build/subprocesses/ ./subprocesses/

# Copy database migrations
COPY --chown=dockhand:dockhand drizzle/ ./drizzle/
COPY --chown=dockhand:dockhand drizzle-pg/ ./drizzle-pg/

# Copy legal documents
COPY --chown=dockhand:dockhand LICENSE.txt PRIVACY.txt ./

# Copy entrypoint script (root-owned, executable)
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Copy emergency scripts
COPY --chown=dockhand:dockhand scripts/emergency/ ./scripts/
RUN chmod +x ./scripts/*.sh ./scripts/**/*.sh 2>/dev/null || true

# Create data directories with correct ownership
RUN mkdir -p /home/dockhand/.dockhand/stacks /app/data \
    && chown dockhand:dockhand /app/data /home/dockhand /home/dockhand/.dockhand /home/dockhand/.dockhand/stacks

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:3000/ || exit 1

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["bun", "run", "./build/index.js"]
