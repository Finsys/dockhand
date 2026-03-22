# syntax=docker/dockerfile:1.4
# =============================================================================
# Dockhand Docker Image - Node.js Runtime (Security-Hardened Build)
# =============================================================================
# Uses Node.js instead of Bun to eliminate BoringSSL native memory leaks
# on mTLS connections. Same Wolfi-based security-hardened OS.
# =============================================================================

# -----------------------------------------------------------------------------
# Stage 1: OS Generator (Alpine + apko tool)
# -----------------------------------------------------------------------------
FROM alpine:3.21 AS os-builder

ARG TARGETARCH

WORKDIR /work

# Install apko tool
ARG APKO_VERSION=0.30.34
RUN apk add --no-cache curl unzip \
    && ARCH=$([ "$TARGETARCH" = "arm64" ] && echo "arm64" || echo "amd64") \
    && curl -sL "https://github.com/chainguard-dev/apko/releases/download/v${APKO_VERSION}/apko_${APKO_VERSION}_linux_${ARCH}.tar.gz" \
       | tar -xz --strip-components=1 -C /usr/local/bin \
    && chmod +x /usr/local/bin/apko

# Generate apko.yaml — Node.js binary comes from node:24-slim, not Wolfi
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
    "    - docker-compose=5.0.2-r1" \
    "    - docker-cli-buildx" \
    "    - sqlite" \
    "    - postgresql-client" \
    "    - git" \
    "    - openssh-client" \
    "    - openssh-keygen" \
    "    - curl" \
    "    - tini" \
    "    - su-exec" \
    "    - glibc" \
    "    - libstdc++" \
    "entrypoint:" \
    "  command: /bin/sh -l" \
    "archs:" \
    "  - ${APKO_ARCH}" \
    > apko.yaml

# Build the OS tarball and extract rootfs
RUN apko build apko.yaml dockhand-base:latest output.tar \
    && mkdir -p rootfs \
    && tar -xf output.tar \
    && LAYER=$(tar -tf output.tar | grep '.tar.gz$' | head -1) \
    && tar -xzf "$LAYER" -C rootfs

# -----------------------------------------------------------------------------
# Stage 2: Application Builder (pure Node.js)
# -----------------------------------------------------------------------------
FROM --platform=$TARGETPLATFORM node:24-slim AS app-builder

WORKDIR /app

# Install build dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    jq git curl python3 make g++ libnss-wrapper \
    && rm -rf /var/lib/apt/lists/* \
    && cp "$(dpkg -L libnss-wrapper | grep 'libnss_wrapper\.so$')" /usr/local/lib/libnss_wrapper.so

# Copy package files and install dependencies
COPY package.json package-lock.json ./
RUN npm ci

# Copy source code and build
COPY . .
RUN npm run build

# Production dependencies only (rebuilds native addons like better-sqlite3)
RUN rm -rf node_modules \
    && npm ci --omit=dev \
    && rm -rf node_modules/@types

# Build Go collector
FROM --platform=$BUILDPLATFORM golang:1.25.8 AS go-builder
ARG TARGETARCH
WORKDIR /app
COPY collector/ ./collector/
RUN cd collector && CGO_ENABLED=0 GOARCH=$TARGETARCH go build -o /app/bin/collection-worker .

# -----------------------------------------------------------------------------
# Stage 3: Final Image (Scratch + Custom Wolfi OS)
# -----------------------------------------------------------------------------
FROM scratch

# Install custom Wolfi OS with Node.js
COPY --from=os-builder /work/rootfs/ /

# Copy Node.js binary from official node:24-slim (platform-correct, conservative CPU baseline)
# Wolfi's nodejs-24 targets ARMv8.1+ which causes SIGILL on Cortex-A53 (Raspberry Pi 3+)
COPY --from=app-builder /usr/local/bin/node /usr/local/bin/node

# Copy libnss_wrapper for git SSH with arbitrary UIDs
COPY --from=app-builder /usr/local/lib/libnss_wrapper.so /usr/lib/libnss_wrapper.so

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

# Create docker compose plugin symlink
RUN mkdir -p /usr/libexec/docker/cli-plugins \
    && ln -sf /usr/bin/docker-compose /usr/libexec/docker/cli-plugins/docker-compose

# Create dockhand user and group
RUN addgroup -g 1001 dockhand \
    && adduser -u 1001 -G dockhand -h /home/dockhand -D dockhand

# Copy application files with correct ownership
COPY --from=app-builder --chown=dockhand:dockhand /app/node_modules ./node_modules
COPY --from=app-builder --chown=dockhand:dockhand /app/package.json ./
COPY --from=app-builder --chown=dockhand:dockhand /app/build ./build
COPY --from=app-builder --chown=dockhand:dockhand /app/server.js ./

# Copy Go collector binary
COPY --from=go-builder --chown=dockhand:dockhand /app/bin/collection-worker ./bin/collection-worker

# Copy database migrations
COPY --chown=dockhand:dockhand drizzle/ ./drizzle/
COPY --chown=dockhand:dockhand drizzle-pg/ ./drizzle-pg/

# Copy legal documents
COPY --chown=dockhand:dockhand LICENSE.txt PRIVACY.txt ./

# Copy entrypoint script
COPY docker-entrypoint-node.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Copy emergency scripts
COPY --chown=dockhand:dockhand scripts/emergency/ ./scripts/
RUN chmod +x ./scripts/*.sh ./scripts/**/*.sh 2>/dev/null || true

# Create data directories
RUN mkdir -p /home/dockhand/.dockhand/stacks /app/data \
    && chown dockhand:dockhand /app/data /home/dockhand /home/dockhand/.dockhand /home/dockhand/.dockhand/stacks

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:${PORT:-3000}/ || exit 1

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD []
