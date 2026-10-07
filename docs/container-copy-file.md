# Preserve files during container updates

Compose injects environment-backed secrets into a container's writable layer. Docker inspect does not contain those files, so recreating the container through the Docker API loses them. Dockhand preserves them by discovering `environment:` secrets in accessible Compose files. The `dockhand.copy-file` label lets you specify additional files or cover deployments where discovery is unavailable.

## Explicit label

Use the label for custom files or when Dockhand cannot read the Compose files:

```yaml
services:
  authelia:
    image: authelia/authelia:4.39
    labels:
      dockhand.copy-file: /run/secrets/authelia_session_secret,/run/secrets/authelia_storage_encryption_key,/run/secrets/authelia_reset_password_jwt_secret
    secrets:
      - authelia_session_secret
      - authelia_storage_encryption_key
      - authelia_reset_password_jwt_secret
    # Keep your existing environment, volumes, and other service settings.

secrets:
  authelia_session_secret:
    environment: AUTH_SESSION_SECRET
  authelia_storage_encryption_key:
    environment: AUTH_STORAGE_ENCRYPTION_KEY
  authelia_reset_password_jwt_secret:
    environment: AUTH_RESET_PASSWORD_JWT_SECRET
```

The label is a comma-separated list of **absolute paths inside the container**. Use the actual target path for secrets or configs with a custom `target:`. Whitespace around entries is ignored and duplicate paths are copied once. Deploy the label onto the existing container before relying on it for updates; editing a Compose file alone does not change a running container's labels.

## Automatic discovery and fallback rules

Before copying files for an update, Dockhand reads these labels from the existing container:

- `com.docker.compose.project.config_files`
- `com.docker.compose.project.working_dir`
- `com.docker.compose.project`
- `com.docker.compose.service`

It resolves relative config paths against `working_dir` and reads the files from Dockhand's filesystem. No stack registry lookup is needed, so this works for both Git stacks and ad-hoc Compose projects when their files are accessible. Compose uses comma-separated config paths on all platforms. Windows-style semicolon lists are also accepted when `working_dir` is a Windows path.

Only `environment:` entries in top-level `secrets:` are eligible, and only when referenced by the container's own service. The project label is authoritative; the YAML's `name:` may have been overridden by `compose -p`. Short references use `/run/secrets/<source>`. Long references honor `source:` and `target:`; relative targets are placed under `/run/secrets`, and absolute targets are used as written. `file:`, `external:`, and `content:` sources and Compose configs are not automatically selected. Ordinary Compose file secrets are read-only bind mounts and remain covered by the existing mount handling.

For example, the Authelia Compose configuration above works without its `dockhand.copy-file` label when Dockhand can read the labeled Compose files. Multiple config files are processed in order: definitions merge by secret name, and service secret references merge by target path. A later reference to a file-sourced secret replaces an environment-sourced reference at the same target.

Discovery silently falls back to **label-only** behavior if any config file is unreadable, invalid, or unsupported. This commonly applies to remote daemons or Hawser Edge environments whose Compose paths do not exist inside Dockhand. It also applies to missing ownership/path labels, stdin configs, `include`, service `extends`, custom YAML tags such as `!reset`/`!override`, and service secret names or targets requiring interpolation. Discovery reads no environment values and performs no interpolation. Reads are limited to 16 config files and 4 MiB total; exceeding those limits also falls back silently. If one override cannot be read, partial discovery is discarded to avoid using outdated targets.

Explicit label paths are merged first, then discovery fills the gaps. Duplicate paths are copied once. Since the label is a list of paths, it cannot rename or exclude a discovered target; removing or clearing it does not disable automatic discovery. Removing it in the container editor removes only explicit paths for that recreation. Discovery uses the current container's Compose metadata even when the edit changes labels.

Discovery uses the files as they exist at update time, so keep them consistent with the deployed container. A selected path that is missing, unreadable, or too large **aborts the update**; it does not trigger label-only fallback. Both layers use the same snapshot limits, mount checks, restoration, and rollback behavior.

## Behavior

- Applies to scheduled image updates, manual image updates, dependent-container recreations, and container edits that recreate the container.
- Captures every required file before stopping the original container, restores them before the replacement starts, and creates missing parent directories.
- Preserves file bytes, numeric owner/group, and ordinary permission bits. Special permission bits, ACLs, and extended attributes are not copied.
- Keeps snapshots in memory and releases them when the operation completes or fails. Secret contents are not written to Dockhand's database, temporary files, or update logs. Paths can appear in logs and Docker labels.
- Missing, unreadable, oversized, or invalid files abort the update before stop. Failed restoration prevents replacement startup and uses Dockhand's rollback to restore the old container. Image updates keep stopped containers stopped; container edits honor the requested start option. An application crash after Docker accepts start is outside this feature's rollback behavior.
- Copies the existing contents; it does not fetch or rotate secrets from the original environment or a secret provider.

When neither layer selects files, recreation behavior is unchanged. The feature does not affect external Compose deployments, container clones, or backup restores.

## Limits and mounts

- At most 64 unique files, 1 MiB per file, and 16 MiB of retained/reserved archive data across concurrent updates. Archive framing and temporary parsing buffers add overhead. If capacity is exhausted, the update fails and can be retried.
- Paths must be clean absolute file paths. Directories, symlinks, hardlinks, traversal segments, control characters, and backslashes are rejected. Commas cannot occur in a filename because they separate entries.
- An exact bind/volume mount destination or a file below a read-only bind/volume mount is skipped: that persistent mount already supplies the file.
- A file below a writable bind/volume mount is copied. This overwrites that path in the shared mount with its captured contents. Other writers can race the snapshot, and container rollback does not undo writes into shared mounts.
- Files on tmpfs and writes into read-only root filesystems are unsupported; the operation fails instead of claiming the files were preserved.
- Systemd/Quadlet-managed containers with selected copy paths are rejected before stopping: their unit owns replacement creation/start, so Dockhand cannot inject files before startup.

The Docker archive API must be allowed if you use a socket proxy, including `HEAD`, `GET`, and `PUT`. Preflight requires a valid `X-Docker-Container-Path-Stat` header from `HEAD`; absent or invalid metadata aborts before downloading or stopping. This prevents a large file or directory from being buffered by Hawser Edge before Dockhand can inspect the archive. The following GET is also bounded by the existing size caps. The same Docker connection used for updating transfers the files; no shell or utility inside the container is needed.

## Development verification

```sh
bun test tests/compose-copy-files.test.ts tests/container-copy-files.test.ts tests/container-copy-files-integration.test.ts
bun scripts/test-container-copy-files-docker.ts
```

The second command is an opt-in real-Docker smoke test. It requires Docker Compose and a local Unix-socket Docker context, creates an isolated Alpine Compose project with synthetic secrets, and cleans up its own resources. It asserts the real daemon's HEAD status, base64 path-stat metadata, file size/mode, and empty response body. It then verifies automatic discovery without a copy label through two recreations, an explicit-label edit, and failure rollback, including custom targets and non-root ownership.
