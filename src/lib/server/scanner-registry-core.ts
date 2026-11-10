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

/**
 * The scanner's full output for classification, from the error the helper threw. The
 * helper's `message` is truncated to ~1000 chars for display, and the export-bug signal
 * usually lands AFTER that point (behind the scanner's INFO lines or a cold-DB progress
 * bar), so the untruncated `stderr`/`stdout` it also carries is what must be classified.
 * Falls back to the message for an error raised anywhere that does not carry them.
 */
export function scanErrorOutput(error: unknown): string {
	if (error && typeof error === 'object') {
		const e = error as { stderr?: unknown; stdout?: unknown; message?: unknown };
		if (typeof e.stderr === 'string' && e.stderr) return e.stderr;
		if (typeof e.stdout === 'string' && e.stdout) return e.stdout;
		if (typeof e.message === 'string') return e.message;
	}
	return String(error);
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
		// A real tag is the best answer. Failing that, a temp tag still names the
		// repository, and stripping its suffix yields the ref that was pulled - which is
		// all a scheduled update's new image carries, since the real tag has already been
		// handed back to the outgoing image.
		const real = tags.find((t) => !isTempTag(t));
		if (real) return toRegistryRef(real);
		for (const temp of tags) {
			const stripped = toRegistryRef(temp);
			if (stripped !== temp) return stripped;
		}
		return image;
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
 * environment (envId, or the 'local' sentinel). Once a blob-export failure is seen
 * for an env, later scans on it go registry-first, avoiding the ~15-50s wasted on a
 * doomed `docker save`; the daemon remains the fallback for a ref no registry can
 * answer. Held for the process lifetime and reset on restart, which is when a store
 * is actually reconfigured - a single daemon success cannot clear it, because blob
 * loss is per-image. In-memory only - no DB, no migration.
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
 * Which of two failures to report when BOTH the registry and the daemon refused a scan.
 *
 * On an env already marked broken the registry is tried first and the daemon is the
 * fallback - a registry cannot answer every ref (a local-only image, a private registry
 * with no stored credentials). When the daemon fails with the export bug again, the
 * registry's error is the actionable one: the operator already knows the export is
 * broken, and the daemon's message would hide why the registry could not stand in. Any
 * other daemon failure (a missing image, a dead socket) is its own problem and is
 * reported as itself.
 */
export function chooseReportedError(
	registryError: string,
	daemonError: string
): 'registry' | 'daemon' {
	return isDaemonExportFailure(daemonError) ? 'registry' : 'daemon';
}

/**
 * The registry coordinates a scan must authenticate against, for the ref it will
 * actually ask for.
 *
 * A bare image ID carries no repository, so resolving it is what makes a private
 * registry's stored credentials findable at all: looked up against the ID itself, the
 * ref parses as Docker Hub's `library/sha256` and never matches. `registry` is fed to
 * the credential lookup and `authority` scopes grype's auth env; both therefore come
 * from the RESOLVED ref, not from the name the daemon was asked for.
 *
 * The parsing is injected (`parseRegistry`) so this stays free of the daemon-side
 * registry module.
 */
export function resolveRegistryScanTarget(
	imageName: string,
	repoTags: string[] | null | undefined,
	parseRegistry: (ref: string) => string
): RegistryScanTarget {
	const ref = toRegistryRef(imageName, repoTags);
	return {
		ref,
		registry: parseRegistry(ref),
		authority: imageRegistryAuthority(ref),
		resolved: ref !== imageName,
		unresolvableId: ref === imageName && needsRepoTags(imageName)
	};
}

/** Everything registry mode needs about the image, decided in one place. */
export interface RegistryScanTarget {
	/** The ref to ask the registry for. */
	ref: string;
	/** The registry whose stored credentials apply. */
	registry: string;
	/** The host scoping grype's auth env, or null for implicit Docker Hub. */
	authority: string | null;
	/** The ref differs from the name the daemon was asked for. */
	resolved: boolean;
	/** A bare ID that no tag could name, so the registry cannot answer it. */
	unresolvableId: boolean;
}

/**
 * Whether resolving this ref needs an image inspect.
 *
 * Only a bare ID does: it carries no repository, so nothing but `RepoTags` can name
 * one. A tag resolves on its own, and the inspect is a remote round-trip worth paying
 * for only on the path that cannot do without it.
 */
export function needsRepoTags(imageName: string): boolean {
	return isBareImageId(imageName);
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
