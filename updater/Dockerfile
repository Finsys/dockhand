# syntax=docker/dockerfile:1.4
# Dockhand Updater - Minimal sidecar for self-updates
# Dockhand pre-creates the new container, this sidecar just does
# stop/rm/rename/network-connect/start via Docker CLI.

# Stage 1: Build minimal Wolfi rootfs with apko
FROM alpine:3.21 AS os-builder

ARG TARGETARCH

WORKDIR /work

ARG APKO_VERSION=0.30.34
RUN apk add --no-cache curl \
    && ARCH=$([ "$TARGETARCH" = "arm64" ] && echo "arm64" || echo "amd64") \
    && curl -sL "https://github.com/chainguard-dev/apko/releases/download/v${APKO_VERSION}/apko_${APKO_VERSION}_linux_${ARCH}.tar.gz" \
       | tar -xz --strip-components=1 -C /usr/local/bin \
    && chmod +x /usr/local/bin/apko

RUN APKO_ARCH=$([ "$TARGETARCH" = "arm64" ] && echo "aarch64" || echo "x86_64") \
    && printf '%s\n' \
    "contents:" \
    "  repositories:" \
    "    - https://packages.wolfi.dev/os" \
    "  keyring:" \
    "    - https://packages.wolfi.dev/os/wolfi-signing.rsa.pub" \
    "  packages:" \
    "    - docker-cli" \
    "    - busybox" \
    "entrypoint:" \
    "  command: /bin/sh -l" \
    "archs:" \
    "  - ${APKO_ARCH}" \
    > apko.yaml

RUN apko build apko.yaml dockhand-updater:latest output.tar \
    && mkdir -p rootfs \
    && tar -xf output.tar \
    && LAYER=$(tar -tf output.tar | grep '.tar.gz$' | head -1) \
    && tar -xzf "$LAYER" -C rootfs

# Stage 2: Scratch + minimal rootfs
FROM scratch

COPY --from=os-builder /work/rootfs/ /
COPY update.sh /update.sh
RUN chmod +x /update.sh

ENTRYPOINT ["/update.sh"]
