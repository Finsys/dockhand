/**
 * What an update check can honestly say when Dockhand cannot inspect its own
 * container.
 *
 * The check normally reads the running container's image and digest, which needs the
 * container runtime. On Kubernetes (and anywhere else without a Docker socket, such
 * as a plain Podman pod) there is no container to inspect, so neither is knowable.
 *
 * The build already stamps the running version in, and the changelog already names
 * the newest release, so the two halves of the comparison are available without
 * touching any runtime. That is strictly less than the full check - it cannot see a
 * rebuilt mutable tag, and it cannot offer to perform the update, because on
 * Kubernetes the image is replaced through the manifest rather than by us - but it
 * answers the question an operator actually asks.
 */

import { compareVersions } from './version';

/** A changelog entry, as the published changelog.json carries it. */
export interface ChangelogRelease {
	version: string;
	comingSoon?: boolean;
}

export interface VersionOnlyCheck {
	updateAvailable: boolean;
	/** The newest released version, without a leading `v`. */
	latestVersion?: string;
	/** The version this build reports, without a leading `v`. */
	currentVersion?: string;
	/**
	 * The runtime could not be inspected, so the answer rests on the build's version
	 * alone. Clients use it to describe the result rather than offer an update.
	 */
	versionOnly: true;
	error?: string;
}

/** The newest entry that is actually released. */
export function latestReleasedVersion(changelog: unknown): string | null {
	if (!Array.isArray(changelog)) return null;
	const released = (changelog as ChangelogRelease[]).find(
		(e) => e && typeof e.version === 'string' && e.version.trim() && !e.comingSoon
	);
	return released ? released.version.trim() : null;
}

/**
 * A version compareVersions can actually order.
 *
 * It reads a version as dot-separated numbers, and a segment that is not one becomes
 * zero - so `1.0.60-rc1` would compare as `1.0.0` and be judged behind `1.0.53`.
 * Anchoring the shape keeps such a version in the no-verdict branch instead, matching
 * what the Docker path already accepts (`-baseline` is the one suffix we publish).
 */
function isPlainVersion(version: string): boolean {
	return /^\d+(\.\d+)*(-baseline)?$/.test(version);
}

/** `v1.0.54` and `1.0.54` are the same version; the comparison wants it bare. */
function bare(version: string): string {
	return version.trim().replace(/^v/i, '');
}

/**
 * Whether a build is behind the newest release, judged on versions alone.
 *
 * An unknown or unparseable running version yields no verdict rather than a guess:
 * claiming "up to date" there would be the one answer an operator cannot check, and
 * claiming an update would nag every development build.
 */
export function checkByVersionOnly(
	runningVersion: string | null | undefined,
	changelog: unknown
): VersionOnlyCheck {
	const current = typeof runningVersion === 'string' ? bare(runningVersion) : '';
	if (!isPlainVersion(current)) {
		return {
			updateAvailable: false,
			versionOnly: true,
			error: 'This build does not report a version, so it cannot be compared with the latest release'
		};
	}

	const latest = latestReleasedVersion(changelog);
	if (!latest) {
		return {
			updateAvailable: false,
			currentVersion: current,
			versionOnly: true,
			error: 'No released version found in the changelog'
		};
	}

	const latestBare = bare(latest);
	if (!isPlainVersion(latestBare)) {
		return {
			updateAvailable: false,
			currentVersion: current,
			versionOnly: true,
			error: 'The latest release is not a plain version number, so it cannot be compared'
		};
	}
	return {
		updateAvailable: compareVersions(latestBare, current) > 0,
		latestVersion: latestBare,
		currentVersion: current,
		versionOnly: true
	};
}
