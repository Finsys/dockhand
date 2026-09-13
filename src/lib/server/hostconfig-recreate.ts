/**
 * Pure HostConfig sanitizers for container recreation (auto-update).
 *
 * recreateContainerFromInspect passes the OLD container's whole HostConfig back to
 * create. Some fields the daemon REPORTS on inspect it REJECTS on create - notably on
 * Podman, whose inspect is less normalized than Docker's. These fixups run in-place
 * just before create.
 */

interface CpuHostConfig {
	NanoCpus?: number;
	CpuPeriod?: number;
	CpuQuota?: number;
}

/**
 * NanoCpus and CpuPeriod/CpuQuota are two encodings of the same CPU limit and are
 * mutually exclusive at create time. Podman's inspect reports BOTH the absolute
 * NanoCpus and the derived period/quota, so replaying the HostConfig trips its
 * "NanoCpus conflicts with CpuPeriod and CpuQuota" error (#1381). Keep NanoCpus (the
 * direct `cpus:` equivalent) and drop the derived pair. Docker reports period/quota as
 * 0 for a `--cpus` container, so the condition never fires there - zero change for
 * Docker, and no effect when a container uses only one of the two encodings.
 *
 * Mutates `hostConfig` in place. Returns true when it dropped the pair.
 */
export function resolveNanoCpusConflict(hostConfig: CpuHostConfig | null | undefined): boolean {
	if (!hostConfig) return false;
	if (!hostConfig.NanoCpus) return false;
	if (!hostConfig.CpuPeriod && !hostConfig.CpuQuota) return false;
	delete hostConfig.CpuPeriod;
	delete hostConfig.CpuQuota;
	return true;
}

const PODMAN_USERNS_ANNOTATION = 'io.podman.annotations.userns';

/**
 * Podman lowers `--userns keep-id`/`auto`/`nomap` to `UsernsMode: "private"` plus generated
 * `IDMappings` in inspect, losing the original intent. Replaying `UsernsMode: "private"` to
 * create WITHOUT inline mappings is rejected ("must provide at least one UID or GID mapping
 * to configure a user namespace", #1409). Podman keeps the real intent in the
 * `io.podman.annotations.userns` annotation, and `create --userns keep-id` regenerates the
 * mappings - so restore the annotation value to keep keep-id working across a recreate.
 *
 * Returns the corrected UsernsMode: the annotation value ("keep-id", "auto",
 * "keep-id:uid=1000,gid=1000", ...) when present, `undefined` to STRIP a bare "private" with
 * no recorded intent, or `null` for "leave UsernsMode untouched". Only the lowered "private"
 * form is ever changed, so Docker (UsernsMode "", "host", "container:x", ...) is never
 * touched - no Docker regression.
 */
export function resolvePodmanUsernsMode(
	usernsMode: string | undefined | null,
	annotations: Record<string, string> | undefined | null
): { mode: string } | { strip: true } | null {
	if (usernsMode !== 'private') return null;
	const intent = annotations?.[PODMAN_USERNS_ANNOTATION]?.trim();
	if (intent) return { mode: intent };
	return { strip: true };
}
