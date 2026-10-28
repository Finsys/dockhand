import { describe, test, expect } from 'bun:test';
import {
	isDaemonExportFailure,
	scanErrorOutput,
	toRegistryScanCmd,
	toRegistryRef,
	registryAuthEnv,
	imageRegistryAuthority,
	RegistryFallbackMemory,
} from '../src/lib/server/scanner-registry-core';

// Real failure output taken verbatim from issue #1569 / #1350 logs.
const GRYPE_BLOB_FAIL =
	`[0000] INFO gathered packages packages=0\n` +
	`[0000] ERROR failed to catalog: errors occurred attempting to resolve 'oci.jeuznetwork.net/poi/starboard-discord-bot:latest':\n` +
	` - snap: snap file "oci.jeuznetwork.net/poi/starboard-discord-bot:latest" does not exist\n` +
	` - docker: unable to provide image from tarball: file blobs/sha256/59a242dc0cb5 does not exist`;

const TRIVY_BLOB_FAIL =
	`FATAL Fatal error run error: image scan error: scan error: scan failed: failed analysis: ` +
	`analyze error: pipeline error: failed to analyze layer (sha256:06cfb6): unable to get uncompressed layer ` +
	`sha256:06cfb6: unable to open: failed to initialize the struct from the temporary file: file blobs/sha256/59a242 `;

const AUTH_FAIL =
	`oci-model: failed to fetch descriptor: GET https://oci.jeuznetwork.net/v2/poi/starboard-discord-bot/manifests/latest: ` +
	`unexpected status code 401 Unauthorized: {"code":"UNAUTHORIZED","message":"authentication required"}`;

describe('isDaemonExportFailure', () => {
	test('matches the grype tarball-missing-blob failure', () => {
		expect(isDaemonExportFailure(GRYPE_BLOB_FAIL)).toBe(true);
	});
	test('matches the trivy uncompressed-layer failure', () => {
		expect(isDaemonExportFailure(TRIVY_BLOB_FAIL)).toBe(true);
	});
	test('does NOT match a 401 auth failure (fallback must not fire on auth errors)', () => {
		expect(isDaemonExportFailure(AUTH_FAIL)).toBe(false);
	});
	test('does NOT match a clean/empty output', () => {
		expect(isDaemonExportFailure('')).toBe(false);
		expect(isDaemonExportFailure(null)).toBe(false);
		expect(isDaemonExportFailure('gathered packages packages=184')).toBe(false);
	});
	test('does NOT match a generic network error', () => {
		expect(isDaemonExportFailure('dial tcp: connection refused')).toBe(false);
	});
	test('does NOT match on the bare phrase "not found in tar" without the blob context', () => {
		// The signature must be specific to the blob-export bug; a stray "not found in
		// tar" in some other error must not trigger a registry fallback + mark-broken.
		expect(isDaemonExportFailure('some archive entry not found in tar listing')).toBe(false);
	});
});

describe('toRegistryScanCmd', () => {
	const IMG = 'oci.jeuznetwork.net/poi/starboard-discord-bot:latest';
	test('grype: prefixes the image token with registry:', () => {
		const daemon = ['-o', 'json', '-v', IMG];
		expect(toRegistryScanCmd('grype', daemon, IMG)).toEqual(['-o', 'json', '-v', `registry:${IMG}`]);
	});
	test('trivy: leaves the image token as the plain ref', () => {
		const daemon = ['image', '--format', 'json', IMG];
		expect(toRegistryScanCmd('trivy', daemon, IMG)).toEqual(['image', '--format', 'json', IMG]);
	});
	test('only the exact image token is rewritten, not a flag that contains it', () => {
		const daemon = ['-o', 'json', IMG];
		const out = toRegistryScanCmd('grype', daemon, IMG);
		expect(out.filter((t) => t.startsWith('registry:')).length).toBe(1);
		expect(out[0]).toBe('-o');
		expect(out[1]).toBe('json');
	});
});

describe('toRegistryRef', () => {
	// An auto-update scans repo:tag-dockhand-pending, a tag that exists only on this
	// host. Carrying it into the registry fallback asks for something never pushed, and
	// the registry answers MANIFEST_UNKNOWN - so both scanners fail and the update is
	// blocked on an image that is in fact fine.
	test('strips the pending suffix the auto-update scan added', () => {
		expect(toRegistryRef('docker.io/gotenberg/gotenberg:latest-dockhand-pending')).toBe(
			'docker.io/gotenberg/gotenberg:latest'
		);
	});

	test('strips the update suffix too', () => {
		expect(toRegistryRef('nginx:1.27-dockhand-update')).toBe('nginx:1.27');
	});

	test('round-trips whatever getTempImageTag produces for a bare name', () => {
		// getTempImageTag('nginx') -> 'nginx:latest-dockhand-pending'
		expect(toRegistryRef('nginx:latest-dockhand-pending')).toBe('nginx:latest');
	});

	test('a real tag is returned unchanged', () => {
		expect(toRegistryRef('docker.io/gotenberg/gotenberg:latest')).toBe(
			'docker.io/gotenberg/gotenberg:latest'
		);
		expect(toRegistryRef('nginx')).toBe('nginx');
	});

	test('a digest ref is left alone', () => {
		// getTempImageTag returns a digest ref unchanged, so one never carries a suffix.
		const d = 'nginx@sha256:' + 'a'.repeat(64);
		expect(toRegistryRef(d)).toBe(d);
	});

	test('a registry port is not mistaken for a tag', () => {
		expect(toRegistryRef('registry.bor6.pl:5000/team/app')).toBe('registry.bor6.pl:5000/team/app');
		expect(toRegistryRef('registry.bor6.pl:5000/team/app:v2-dockhand-pending')).toBe(
			'registry.bor6.pl:5000/team/app:v2'
		);
	});

	test('the words only count as a suffix of the final tag', () => {
		// A repository legitimately named after the suffix must survive intact, and so
		// must a tag that merely contains the words in the middle.
		expect(toRegistryRef('docker.io/acme/dockhand-pending-tools:v1')).toBe(
			'docker.io/acme/dockhand-pending-tools:v1'
		);
		expect(toRegistryRef('acme/app:-dockhand-pending-rc1')).toBe('acme/app:-dockhand-pending-rc1');
	});

	test('a tag that is nothing but the suffix is left alone', () => {
		// Stripping would leave an empty tag, which is not a ref the registry can answer.
		expect(toRegistryRef('acme/app:-dockhand-pending')).toBe('acme/app:-dockhand-pending');
	});
});

describe('toRegistryRef for the bare image ID the auto-update scans with', () => {
	// The per-container auto-update scans by image ID, because that ID keys the scan
	// cache. A registry cannot answer an ID - it carries no repository - so the real
	// tag has to come from the image inspect.
	const ID = 'sha256:' + 'b'.repeat(64);

	test('resolves to the real tag from the inspect', () => {
		expect(toRegistryRef(ID, ['docker.io/gotenberg/gotenberg:latest'])).toBe(
			'docker.io/gotenberg/gotenberg:latest'
		);
	});

	test('a short digest with no sha256 prefix resolves too', () => {
		expect(toRegistryRef('b'.repeat(64), ['nginx:1.27'])).toBe('nginx:1.27');
	});

	test('prefers a real tag over the temp tag sitting beside it', () => {
		// Mid-update the image carries both, and the temp one is exactly what the
		// registry cannot answer.
		expect(
			toRegistryRef(ID, ['nginx:1.27-dockhand-pending', 'nginx:1.27'])
		).toBe('nginx:1.27');
	});

	test('a lone temp tag is stripped to the ref that was pulled', () => {
		// What a scheduled update's new image carries: the real tag went back to the
		// outgoing image before the scan, so the temp tag is the only name left. Its
		// stripped form is exactly what was pulled, and the registry can answer it.
		expect(toRegistryRef(ID, ['nginx:1.27-dockhand-pending'])).toBe('nginx:1.27');
		expect(toRegistryRef(ID, ['busybox:latest-dockhand-pending'])).toBe('busybox:latest');
		expect(toRegistryRef(ID, ['registry.bor6.pl:5000/team/app:v2-dockhand-update'])).toBe(
			'registry.bor6.pl:5000/team/app:v2'
		);
	});

	test('a temp tag that strips to nothing usable stays the ID', () => {
		// The suffix alone is not a repository, so there is no ref to offer.
		expect(toRegistryRef(ID, ['acme/app:-dockhand-pending'])).toBe(ID);
	});

	test('a tag merely containing the suffix is not treated as a temp tag', () => {
		// It is a real tag, so it is returned as-is rather than mangled.
		expect(toRegistryRef(ID, ['acme/dockhand-pending-tools:v1'])).toBe(
			'acme/dockhand-pending-tools:v1'
		);
	});

	test('stays the ID when the inspect offers nothing usable', () => {
		// Better an unresolvable ref and the registry's own error than a guess.
		expect(toRegistryRef(ID, [])).toBe(ID);
		expect(toRegistryRef(ID, undefined)).toBe(ID);
		expect(toRegistryRef(ID, ['<none>:<none>'])).toBe(ID);
	});

	test('repoTags are ignored for a ref that is already resolvable', () => {
		// A real ref is what the caller asked about; a RepoTag must not redirect it.
		expect(toRegistryRef('nginx:1.27', ['other/image:v9'])).toBe('nginx:1.27');
		expect(toRegistryRef('nginx:1.27-dockhand-pending', ['other/image:v9'])).toBe('nginx:1.27');
	});

	test('a 64-hex string is an ID, a shorter hex tag is not', () => {
		// 'repo:abc123' is a legitimate tag, not a digest, and must be left alone.
		expect(toRegistryRef('repo:abc123', ['other:v1'])).toBe('repo:abc123');
	});
});

describe('toRegistryScanCmd with a distinct registry ref', () => {
	const LOCAL = 'docker.io/gotenberg/gotenberg:latest-dockhand-pending';
	const REAL = 'docker.io/gotenberg/gotenberg:latest';

	test('grype asks the registry for the real tag, not the local one', () => {
		const daemon = ['-o', 'json', '-v', LOCAL];
		expect(toRegistryScanCmd('grype', daemon, LOCAL, REAL)).toEqual([
			'-o',
			'json',
			'-v',
			`registry:${REAL}`
		]);
	});

	test('trivy asks the registry for the real tag, not the local one', () => {
		const daemon = ['image', '--format', 'json', LOCAL];
		expect(toRegistryScanCmd('trivy', daemon, LOCAL, REAL)).toEqual([
			'image',
			'--format',
			'json',
			REAL
		]);
	});

	test('the token is still matched on the ref the daemon was given', () => {
		// The command carries the local tag; matching on the real one would rewrite nothing.
		const daemon = ['-o', 'json', LOCAL];
		expect(toRegistryScanCmd('grype', daemon, LOCAL, REAL)).not.toContain(LOCAL);
	});
});

describe('registryAuthEnv', () => {
	const creds = { username: 'poi', password: 's3cret' };
	test('grype: GRYPE_REGISTRY_AUTH_* with authority', () => {
		expect(registryAuthEnv('grype', creds, 'oci.jeuznetwork.net')).toEqual([
			'GRYPE_REGISTRY_AUTH_USERNAME=poi',
			'GRYPE_REGISTRY_AUTH_PASSWORD=s3cret',
			'GRYPE_REGISTRY_AUTH_AUTHORITY=oci.jeuznetwork.net',
		]);
	});
	test('trivy: TRIVY_USERNAME/PASSWORD', () => {
		expect(registryAuthEnv('trivy', creds)).toEqual(['TRIVY_USERNAME=poi', 'TRIVY_PASSWORD=s3cret']);
	});
	test('null creds -> no auth env (public image, anonymous)', () => {
		expect(registryAuthEnv('grype', null, 'ghcr.io')).toEqual([]);
		expect(registryAuthEnv('trivy', null)).toEqual([]);
	});
	test('grype without authority omits the AUTHORITY var', () => {
		expect(registryAuthEnv('grype', creds)).toEqual([
			'GRYPE_REGISTRY_AUTH_USERNAME=poi',
			'GRYPE_REGISTRY_AUTH_PASSWORD=s3cret',
		]);
	});
});

describe('imageRegistryAuthority', () => {
	test('private registry host with dot', () => {
		expect(imageRegistryAuthority('oci.jeuznetwork.net/poi/bot:latest')).toBe('oci.jeuznetwork.net');
	});
	test('ghcr.io', () => {
		expect(imageRegistryAuthority('ghcr.io/mealie-recipes/mealie:latest')).toBe('ghcr.io');
	});
	test('host with port', () => {
		expect(imageRegistryAuthority('registry.bor6.pl:5000/app:tag')).toBe('registry.bor6.pl:5000');
	});
	test('localhost', () => {
		expect(imageRegistryAuthority('localhost:5000/app')).toBe('localhost:5000');
	});
	test('implicit Docker Hub (no host) -> null', () => {
		expect(imageRegistryAuthority('alpine:latest')).toBeNull();
		expect(imageRegistryAuthority('library/alpine:latest')).toBeNull();
	});
});

describe('RegistryFallbackMemory', () => {
	test('an unseen env prefers the daemon path (not registry)', () => {
		const m = new RegistryFallbackMemory();
		expect(m.prefersRegistry(5)).toBe(false);
		expect(m.prefersRegistry(null)).toBe(false);
	});
	test('once marked broken, that env prefers registry on later scans', () => {
		const m = new RegistryFallbackMemory();
		m.markBroken(5);
		expect(m.prefersRegistry(5)).toBe(true);
	});
	test('is per-env: marking one env does not affect another', () => {
		const m = new RegistryFallbackMemory();
		m.markBroken(5);
		expect(m.prefersRegistry(7)).toBe(false);
		expect(m.prefersRegistry(null)).toBe(false);
	});
	test('the local sentinel (null/undefined) is its own env and is stable', () => {
		const m = new RegistryFallbackMemory();
		m.markBroken(null);
		expect(m.prefersRegistry(null)).toBe(true);
		expect(m.prefersRegistry(undefined)).toBe(true);
		expect(m.prefersRegistry(1)).toBe(false);
	});
	test('clear resets everything (restart semantics)', () => {
		const m = new RegistryFallbackMemory();
		m.markBroken(5);
		m.clear();
		expect(m.prefersRegistry(5)).toBe(false);
	});
});

describe('scanErrorOutput (classify on the full output, not the truncated message)', () => {
	// A real scanner prints many INFO/progress lines before it fails, so the
	// export-bug signature lands well past the 1000-char point the helper's error
	// MESSAGE is truncated to. The helper carries the untruncated output on the
	// error so the fallback can still classify it.
	const padding = Array.from(
		{ length: 40 },
		(_, i) => `[0000] INFO cataloging package catalogers index=${i} name=some-catalog-name`
	).join('\n');
	const signatureLine =
		` - docker: unable to provide image from tarball: file blobs/sha256/59a242dc0cb5 does not exist`;
	const fullStderr = `${padding}\n${signatureLine}`;
	const truncatedMessage = `Container exited with code 1: ${fullStderr}`.substring(0, 1000);

	test('the signature is genuinely past the 1000-char message cut', () => {
		// Guards the premise: if this ever fits in the message, the test proves nothing.
		expect(fullStderr.length).toBeGreaterThan(1000);
		expect(isDaemonExportFailure(truncatedMessage)).toBe(false);
		expect(isDaemonExportFailure(fullStderr)).toBe(true);
	});

	test('prefers the error stderr over its truncated message', () => {
		const err = Object.assign(new Error(truncatedMessage), { stderr: fullStderr });
		expect(isDaemonExportFailure(scanErrorOutput(err))).toBe(true);
	});

	test('falls back to stdout when stderr is empty', () => {
		const err = Object.assign(new Error('Container exited with code 1'), {
			stderr: '',
			stdout: fullStderr
		});
		expect(scanErrorOutput(err)).toBe(fullStderr);
	});

	test('falls back to the message for an error that carries no output', () => {
		expect(scanErrorOutput(new Error('plain failure'))).toBe('plain failure');
	});

	test('handles a non-Error thrown value', () => {
		expect(scanErrorOutput('string failure')).toBe('string failure');
		expect(scanErrorOutput(null)).toBe('null');
	});
});
