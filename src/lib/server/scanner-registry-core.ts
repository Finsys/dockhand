/**
 * Pure helpers for the registry-scan fallback (no docker/db imports, unit-tested).
 *
 * On a containerd/OCI image store, `docker save` can silently emit a tar whose
 * index references layer blobs that are not in the archive, so grype/trivy fail
 * with "blob not found in tar". The fix is to re-scan straight from the registry
 * (grype `registry:<ref>`, trivy without the daemon socket), which bypasses the
 * broken daemon export. These helpers classify that failure and shape the
 * registry-mode command + auth env.
 */

export type ScannerType = 'grype' | 'trivy';

/**
 * True when a scanner's output/error is the containerd daemon-export blob bug,
 * i.e. the daemon handed the scanner an incomplete tar. Matched by the stable
 * substrings both scanners print (grype via stereoscope, trivy via its analyzer).
 * Deliberately narrow: it must NOT match an auth/network failure, so the fallback
 * only fires for the export bug.
 */
export function isDaemonExportFailure(output: string | null | undefined): boolean {
	if (!output) return false;
	const s = output.toLowerCase();
	return (
		s.includes('unable to provide image from tarball') || // grype/stereoscope
		(s.includes('unable to get uncompressed layer') && s.includes('failed to analyze layer')) || // trivy
		(s.includes('does not exist') && s.includes('blobs/sha256/')) // "file blobs/sha256/... does not exist"
	);
}

/** A bare image ID: `sha256:<64 hex>` or the digest alone, as the auto-update passes. */
function isBareImageId(ref: string): boolean {
	return /^(sha256:)?[0-9a-f]{64}$/.test(ref);
}

/** A tag Dockhand applies to itself while judging a pending update. */
function isTempTag(tag: string): boolean {
	return /-dockhand-(pending|update)$/.test(tag);
}

/**
 * The ref to ask a registry for, given the ref the daemon was asked for.
 *
 * Neither of the refs an auto-update scans with means anything to a registry. One path
 * scans a temporary local tag (`repo:tag-dockhand-pending`) so the new image can be
 * judged before it takes the real tag; another scans the bare image ID, which keys the
 * scan cache. Sending either one asks for something that was never pushed, and the
 * registry answers MANIFEST_UNKNOWN.
 *
 * A temp tag is resolved by removing the suffix, which getTempImageTag appends verbatim
 * and only to the final tag component - a repository or registry port containing the
 * same words is left alone. A bare ID carries no repository at all, so it is resolved
 * from `repoTags` (an image inspect), preferring a real tag over a temp one.
 *
 * Returns the ref unchanged when it is already something a registry can answer, or when
 * nothing better is known.
 */
export function toRegistryRef(image: string, repoTags?: string[] | null): string {
	if (isBareImageId(image)) {
		const tags = (repoTags || []).filter(
			(t) => typeof t === 'string' && t && t !== '<none>:<none>'
		);
		// Prefer a real tag; if the only available tag is a temp tag (e.g. during safe-pull
		// where the real tag was restored to the safe image), clean and use the temp tag.
		const real = tags.find((t) => !isTempTag(t));
		const candidate = real || tags.find((t) => isTempTag(t));
		return candidate ? toRegistryRef(candidate) : image;
	}

	// A digest pins the content and resolves in the registry as-is.
	if (image.includes('@')) return image;

	const lastColon = image.lastIndexOf(':');
	if (lastColon === -1) return image;

	const tag = image.slice(lastColon + 1);
	// A colon before a slash is a port, not a tag separator (registry:5000/repo).
	if (tag.includes('/')) return image;

	for (const suffix of ['-dockhand-pending', '-dockhand-update']) {
		if (tag.endsWith(suffix) && tag.length > suffix.length) {
			return `${image.slice(0, lastColon)}:${tag.slice(0, -suffix.length)}`;
		}
	}
	return image;
}

/**
 * Rewrite a daemon-mode scanner command into a registry-mode one for the same image.
 * grype needs the source prefix `registry:<ref>`; trivy scans the registry ref as-is
 * once the docker socket is absent. The image token is identified by exact match
 * against `image` (parseCliArgs substitutes {image} with the ref verbatim), while
 * `registryRef` is what the registry is actually asked for - they differ when the
 * daemon was scanning a temporary local tag.
 */
export function toRegistryScanCmd(
	scannerType: ScannerType,
	cmd: string[],
	image: string,
	registryRef: string = image
): string[] {
	return cmd.map((tok) => {
		if (tok !== image) return tok;
		return scannerType === 'grype' ? `registry:${registryRef}` : registryRef;
	});
}

/**
 * Registry credentials as scanner env vars. grype reads GRYPE_REGISTRY_AUTH_*;
 * trivy reads TRIVY_USERNAME/TRIVY_PASSWORD. `authority` is the registry host so
 * grype scopes the credential to it. Returns [] when creds is null (public image,
 * anonymous access - same as before this fix).
 */
export function registryAuthEnv(
	scannerType: ScannerType,
	creds: { username: string; password: string } | null,
	authority?: string,
): string[] {
	if (!creds) return [];
	if (scannerType === 'grype') {
		const env = [
			`GRYPE_REGISTRY_AUTH_USERNAME=${creds.username}`,
			`GRYPE_REGISTRY_AUTH_PASSWORD=${creds.password}`,
		];
		if (authority) env.push(`GRYPE_REGISTRY_AUTH_AUTHORITY=${authority}`);
		return env;
	}
	return [
		`TRIVY_USERNAME=${creds.username}`,
		`TRIVY_PASSWORD=${creds.password}`,
	];
}

/**
 * Per-environment memory of "this daemon's image store loses blobs on export, so
 * skip the daemon path and scan straight from the registry". Keyed by the scan's
 * environment (envId, or the 'local' sentinel). Sticky for the process lifetime:
 * once a blob-export failure is seen for an env, every later scan on that env goes
 * registry-first, avoiding the ~15-50s wasted on a doomed `docker save`. Reset on
 * Dockhand restart so a fixed store returns to the fast daemon path automatically.
 * In-memory only - no DB, no migration.
 */
export class RegistryFallbackMemory {
	private readonly envs = new Set<string>();
	private key(envId: number | null | undefined): string {
		return envId == null ? 'local' : String(envId);
	}
	/** True if this env is known-broken and should scan registry-first. */
	prefersRegistry(envId: number | null | undefined): boolean {
		return this.envs.has(this.key(envId));
	}
	/** Record that this env's daemon export is broken (blob-loss seen). */
	markBroken(envId: number | null | undefined): void {
		this.envs.add(this.key(envId));
	}
	/** Test/reset hook. */
	clear(): void {
		this.envs.clear();
	}
}

/**
 * The registry host (authority) of an image ref, or null for an implicit-Docker-Hub
 * ref (no host component). Used to scope grype's registry auth. A host is the first
 * path segment only when it contains a '.' or ':' (or is 'localhost') - the Docker
 * ref grammar for distinguishing a registry from a Docker Hub org.
 */
export function imageRegistryAuthority(image: string): string | null {
	const firstSlash = image.indexOf('/');
	if (firstSlash === -1) return null; // e.g. "alpine:latest" -> Docker Hub
	const head = image.slice(0, firstSlash);
	if (head === 'localhost' || head.includes('.') || head.includes(':')) return head;
	return null; // e.g. "library/alpine" -> Docker Hub org, not a registry host
}
