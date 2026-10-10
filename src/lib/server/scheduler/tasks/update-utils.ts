/**
 * Shared utilities for container and environment auto-update tasks.
 */

import type { VulnerabilityCriteria } from '../../db';
import type { VulnerabilitySeverity } from '../../scanner';

/**
 * Parse image name and tag from a full image reference.
 * Handles various formats:
 * - nginx → ["nginx", "latest"]
 * - nginx:1.25 → ["nginx", "1.25"]
 * - registry.example.com:5000/myimage:v1 → ["registry.example.com:5000/myimage", "v1"]
 * - nginx:latest-dockhand-pending → ["nginx", "latest-dockhand-pending"]
 */
export function parseImageNameAndTag(imageName: string): [string, string] {
	// Handle digest-based images (return as-is with empty tag)
	if (imageName.includes('@sha256:')) {
		return [imageName, ''];
	}

	// Find the last colon that's part of the tag (not part of registry port)
	const lastColon = imageName.lastIndexOf(':');
	if (lastColon === -1) {
		return [imageName, 'latest'];
	}

	// Check if this colon is part of a registry port
	// Registry ports appear before a slash: registry:5000/image
	const afterColon = imageName.substring(lastColon + 1);
	if (afterColon.includes('/')) {
		// The colon is part of the registry, not the tag
		return [imageName, 'latest'];
	}

	// The colon separates repo from tag
	return [imageName.substring(0, lastColon), afterColon];
}

/**
 * Classify a container whose RUNNING image carries NO local repo digests (#1288).
 *
 * An empty RepoDigests set is ambiguous: it is what you see BOTH for a genuinely
 * local/built image (nothing to check against a registry) AND for a registry image
 * whose tag has since moved to a newer pull — leaving the container on an old,
 * now-untagged, digest-less image. The old code assumed "empty digests ⇒ local" and
 * skipped the update check forever, stranding exactly the containers that DO need an
 * update.
 *
 * The tie-breaker is whether the registry could resolve the container's Config.Image
 * tag (looked up separately, since that's async I/O):
 *  - registry answered  ⇒ it's a registry image, and since the running image has no
 *    digest to match, an update is available.
 *  - registry didn't    ⇒ truly local (or unreachable) ⇒ leave it classified local.
 *
 * @param registryDigest the digest returned for Config.Image's tag, or null/undefined
 *                        if the registry couldn't resolve it.
 */
export function classifyEmptyDigestImage(
	registryDigest: string | null | undefined
): { hasUpdate: boolean; isLocalImage: boolean; registryDigest?: string } {
	if (!registryDigest) {
		return { hasUpdate: false, isLocalImage: true };
	}
	return { hasUpdate: true, isLocalImage: false, registryDigest };
}

/**
 * Extract the per-architecture child manifest digests from a fetched manifest-list /
 * OCI image-index body. Returns [] for anything that isn't an index (single-arch
 * manifest, error body, garbage) - the caller treats "no children" as "no match".
 * Pure + defensive so it can be unit-tested without touching the network (#1367).
 */
export function indexChildDigests(indexBody: unknown): string[] {
	const manifests = (indexBody as { manifests?: unknown })?.manifests;
	if (!Array.isArray(manifests)) return [];
	return manifests
		.map((m) => (m as { digest?: unknown })?.digest)
		.filter((d): d is string => typeof d === 'string' && d.length > 0);
}

/**
 * True if any of the running image's local digests is one of the index's per-arch
 * child digests - i.e. the local image IS the current multi-arch tag, just recorded
 * by its per-arch digest instead of the index digest (#1367).
 */
export function localDigestIsIndexChild(localDigests: string[], indexBody: unknown): boolean {
	const children = indexChildDigests(indexBody);
	return children.some((d) => localDigests.includes(d));
}

/**
 * Determine if an update should be blocked based on vulnerability criteria.
 */
export function shouldBlockUpdate(
	criteria: VulnerabilityCriteria,
	newScanSummary: VulnerabilitySeverity,
	currentScanSummary?: VulnerabilitySeverity
): { blocked: boolean; reason: string } {
	const totalVulns = newScanSummary.critical + newScanSummary.high + newScanSummary.medium + newScanSummary.low;

	switch (criteria) {
		case 'any':
			if (totalVulns > 0) {
				return {
					blocked: true,
					reason: `Found ${totalVulns} vulnerabilities (${newScanSummary.critical} critical, ${newScanSummary.high} high, ${newScanSummary.medium} medium, ${newScanSummary.low} low)`
				};
			}
			break;
		case 'critical_high':
			if (newScanSummary.critical > 0 || newScanSummary.high > 0) {
				return {
					blocked: true,
					reason: `Found ${newScanSummary.critical} critical and ${newScanSummary.high} high severity vulnerabilities`
				};
			}
			break;
		case 'critical':
			if (newScanSummary.critical > 0) {
				return {
					blocked: true,
					reason: `Found ${newScanSummary.critical} critical vulnerabilities`
				};
			}
			break;
		case 'more_than_current':
			if (currentScanSummary) {
				const currentTotal = currentScanSummary.critical + currentScanSummary.high + currentScanSummary.medium + currentScanSummary.low;
				if (totalVulns > currentTotal) {
					return {
						blocked: true,
						reason: `New image has ${totalVulns} vulnerabilities vs ${currentTotal} in current image`
					};
				}
			}
			break;
		case 'never':
		default:
			break;
	}

	return { blocked: false, reason: '' };
}

/**
 * Check if a container is the Dockhand application itself.
 * Used to prevent Dockhand from updating its own container.
 */
export function isDockhandContainer(imageName: string): boolean {
	const lower = imageName.toLowerCase();
	// Match fnsys/dockhand, registry.example.com/dockhand, or plain dockhand
	return lower.includes('fnsys/dockhand') || /(?:^|\/)dockhand(?::|$)/.test(lower);
}

/**
 * Check if a container is a Hawser agent.
 * Official image: ghcr.io/finsys/hawser
 */
export function isHawserContainer(imageName: string): boolean {
	const lower = imageName.toLowerCase();
	return lower.includes('finsys/hawser') || lower.includes('ghcr.io/finsys/hawser');
}

/** What a container would have to look like to be an environment's transport. */
export interface TransportCandidate {
	name?: string;
	/** Host paths this container mounts, as the daemon reports them. */
	mountSources?: (string | null | undefined)[];
	/** The HOST side of each published port, with the address it is bound to.
	 *  The host port is the one the environment is reached on; the container port
	 *  can differ (`-p 12375:2375`). */
	publishedPorts?: ({ port?: number | null; hostIp?: string | null } | number | null | undefined)[];
}

/**
 * Whether a container is the one carrying Dockhand's connection to this
 * environment's daemon.
 *
 * Stopping it severs the connection mid-update, so the recreate can never finish
 * and every later call fails until somebody restarts it by hand - the same reason
 * Dockhand and the Hawser agent are off limits (#1689).
 *
 * Identified by what it DOES, not by what it is called: a socket proxy mounts the
 * docker socket AND publishes the port the environment is reached on. Both are
 * required, because either alone is common - plenty of containers mount the socket
 * read-only, and any container may publish a port. A name match is accepted too,
 * for a host addressed as a container (`socket-proxy:2375`) where the port is
 * published inside a user network rather than on the host.
 *
 * Deliberately not matched on the image name: there are many proxy images, and a
 * list of them would be wrong the day someone uses a different one.
 */
export function isEnvironmentTransportContainer(
	candidate: TransportCandidate | string | undefined,
	environmentHost: string | null | undefined,
	environmentPort?: number | null
): boolean {
	const c: TransportCandidate =
		typeof candidate === 'string' ? { name: candidate } : (candidate ?? {});

	// Every branch needs the socket: a container that cannot talk to the daemon is
	// not carrying anyone's connection to it, and without this the name branch alone
	// lets a container named after the environment's host exempt itself from updates.
	const mountsSocket = (c.mountSources ?? []).some(
		(src) => typeof src === 'string' && DOCKER_SOCKET.test(src)
	);
	if (!mountsSocket) return false;

	if (matchesHostName(c.name, environmentHost)) return true;

	// The functional signal: the socket in, the environment's port out. The caller
	// passes a port only for a connection that is actually made over one - a socket
	// or edge environment stores 2375 in the same column without reaching anything
	// through it, and reading that would skip an unrelated container that happens to
	// publish 2375.
	if (environmentPort == null) return false;
	return (c.publishedPorts ?? []).some((p) => {
		const binding = typeof p === 'number' ? { port: p } : p;
		if (!binding || binding.port !== environmentPort) return false;
		// Two proxies on one machine both publish 2375, each on its own address, so
		// a bound address must be the environment's host to count. A wildcard binding
		// answers for every address and cannot narrow anything.
		return bindingReaches(binding.hostIp, environmentHost);
	});
}

/** Whether a port binding's address is one the environment's host would arrive on. */
function bindingReaches(hostIp: string | null | undefined, environmentHost: string | null | undefined): boolean {
	const ip = (hostIp ?? '').trim();
	if (ip === '' || ip === '0.0.0.0' || ip === '::' || ip === '[::]') return true;
	const host = (environmentHost ?? '').trim().toLowerCase();
	if (!host) return true;
	return ip.toLowerCase() === host;
}

/** The daemon socket, at its usual path or a rootless one. */
const DOCKER_SOCKET = /(^|\/)docker\.sock$/;

/**
 * A host that is an IP address names a machine, not a container, so it can never
 * match; only a DNS-style host (`socket-proxy`, or `socket-proxy.lan` for a
 * container called `socket-proxy`) is compared, case-insensitively because docker
 * names are case-sensitive but DNS is not.
 */
function matchesHostName(
	containerName: string | undefined,
	environmentHost: string | null | undefined
): boolean {
	if (!containerName || !environmentHost) return false;
	const host = environmentHost.trim().toLowerCase();
	if (!host || IP_LIKE_HOST.test(host) || host.includes(':')) return false;
	return host.split('.')[0] === containerName.trim().toLowerCase();
}

/** An IPv4 literal, or anything bracketed as IPv6 - a machine, never a container. */
const IP_LIKE_HOST = /^(\d{1,3}\.){3}\d{1,3}$|^\[/;

/**
 * Whether a batch selection is still worth acting on, given what the last update
 * check recorded for that container.
 *
 * A selection is made from a list the browser already has, and the world can move
 * under it: updating a container outside Dockhand (a compose pull, say) leaves the
 * pending row behind, so the batch would pull and recreate a container that is
 * already current (#1689). The recorded image is the evidence - when the container
 * no longer runs it, the row describes a container that no longer exists.
 *
 * Absent evidence means PROCEED: a container with no pending row may simply have
 * been selected by hand, and refusing those would break updating on demand.
 */
export function batchUpdateStillApplies(
	recordedImage: string | null | undefined,
	currentImage: string | null | undefined
): boolean {
	if (!recordedImage || !currentImage) return true;
	return recordedImage.trim() === currentImage.trim();
}

/**
 * System container type - containers that cannot be updated from within Dockhand.
 */
export type SystemContainerType = 'dockhand' | 'hawser';

/**
 * Check if a container is a system container (Dockhand or Hawser).
 * System containers cannot be updated from within Dockhand because:
 * - Dockhand: Would need to stop itself to update
 * - Hawser: Would disconnect from the environment it's managing
 */
export function isSystemContainer(imageName: string): SystemContainerType | null {
	if (isDockhandContainer(imageName)) return 'dockhand';
	if (isHawserContainer(imageName)) return 'hawser';
	return null;
}

/**
 * Podman creates a hidden "pod-infra" container per pod, always named
 * `<pod-id-or-name>-infra` (#1221). The infra image is locally generated
 * and can be overridden via --infra-image, so neither image nor label is
 * universal — the name suffix is the only reliable signal.
 *
 * Anchored to the end so user containers like "my-infrastructure" don't match.
 */
export function isPodmanInfraContainer(containerName: string | undefined): boolean {
	return !!containerName && /[-_]infra$/i.test(containerName);
}

/**
 * Combine multiple scan summaries by taking the maximum of each severity level.
 */
export function combineScanSummaries(results: { summary: VulnerabilitySeverity }[]): VulnerabilitySeverity {
	return results.reduce((acc, result) => ({
		critical: Math.max(acc.critical, result.summary.critical),
		high: Math.max(acc.high, result.summary.high),
		medium: Math.max(acc.medium, result.summary.medium),
		low: Math.max(acc.low, result.summary.low),
		negligible: Math.max(acc.negligible, result.summary.negligible),
		unknown: Math.max(acc.unknown, result.summary.unknown)
	}), { critical: 0, high: 0, medium: 0, low: 0, negligible: 0, unknown: 0 });
}
