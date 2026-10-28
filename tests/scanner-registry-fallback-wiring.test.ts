// @ts-expect-error -- bun:test is a runtime built-in with no types installed
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	chooseReportedError,
	resolveRegistryScanTarget,
	isDaemonExportFailure,
	RegistryFallbackMemory,
	needsRepoTags
} from '../src/lib/server/scanner-registry-core';

// The registry-first fallback's decisions live in the pure core and are tested here as
// BEHAVIOUR. scanner.ts cannot be imported under bun (better-sqlite3), so the few
// source-text assertions at the bottom pin only that the branch still DELEGATES to the
// core - a text assertion proves spelling, not behaviour, so everything that can be
// decided in the core is decided there.
const scannerSrc = readFileSync(
	join(import.meta.dir, '..', 'src/lib/server/scanner.ts'),
	'utf8'
);

/** How image pulls parse a registry, mirrored so the core can be driven standalone. */
const parseRegistry = (ref: string): string => {
	const head = ref.split('/')[0];
	return ref.includes('/') && (head.includes('.') || head.includes(':') || head === 'localhost')
		? head
		: 'index.docker.io';
};

describe('which failure is reported when both halves refuse', () => {
	const BLOB = 'failed to catalog: unable to provide image from tarball';
	const TRIVY_BLOB = 'unable to get uncompressed layer: failed to analyze layer sha256:abc';
	const UNAUTH = 'UNAUTHORIZED: authentication required';

	test('a daemon still losing blobs yields the registry error', () => {
		// The operator already knows the export is broken; what is missing is why the
		// registry could not stand in.
		expect(chooseReportedError(UNAUTH, BLOB)).toBe('registry');
		expect(chooseReportedError('MANIFEST_UNKNOWN', TRIVY_BLOB)).toBe('registry');
	});

	test('any other daemon failure is reported as itself', () => {
		expect(chooseReportedError(UNAUTH, 'No such image: sha256:deadbeef')).toBe('daemon');
		expect(chooseReportedError(UNAUTH, 'dial unix /var/run/docker.sock: no such file')).toBe('daemon');
		expect(chooseReportedError(UNAUTH, 'Container exited with code 137')).toBe('daemon');
		expect(chooseReportedError(UNAUTH, '')).toBe('daemon');
	});

	test('the choice turns on the daemon error alone, never the registry one', () => {
		// The registry error is what gets reported, not what decides.
		for (const reg of [UNAUTH, 'MANIFEST_UNKNOWN', 'connection refused', '']) {
			expect(chooseReportedError(reg, BLOB)).toBe('registry');
			expect(chooseReportedError(reg, 'No such image')).toBe('daemon');
		}
	});

	test('it agrees with the classifier the daemon-first path uses', () => {
		// One definition of "the export bug", so the two paths cannot diverge.
		for (const msg of [BLOB, TRIVY_BLOB, 'No such image', 'timeout', '']) {
			expect(chooseReportedError('x', msg) === 'registry').toBe(isDaemonExportFailure(msg));
		}
	});
});

describe('which registry a scan authenticates against', () => {
	const ID = 'sha256:' + 'a'.repeat(64);

	test('a bare image ID authenticates against its private registry, not Docker Hub', () => {
		// This is the #1737 credential half: looked up against the bare ID, the ref
		// parses as Docker Hub's library/sha256 and a stored private credential never
		// matches, so a good image fails UNAUTHORIZED.
		const t = resolveRegistryScanTarget(
			ID,
			['registry.bor6.pl:5000/team/app:v2-dockhand-pending'],
			parseRegistry
		);
		expect(t.ref).toBe('registry.bor6.pl:5000/team/app:v2');
		expect(t.registry).toBe('registry.bor6.pl:5000');
		expect(t.authority).toBe('registry.bor6.pl:5000');
	});

	test('the coordinates always describe the ref that is scanned', () => {
		// ref, registry and authority come from one resolution, so they cannot disagree
		// about which image is being read.
		for (const tags of [
			['registry.bor6.pl:5000/team/app:v2-dockhand-pending'],
			['ghcr.io/acme/app:1.2.3'],
			['nginx:1.27-dockhand-update']
		]) {
			const t = resolveRegistryScanTarget(ID, tags, parseRegistry);
			expect(t.registry).toBe(parseRegistry(t.ref));
		}
	});

	test('an unresolvable ID keeps Docker Hub and no authority', () => {
		// Nothing better is known; the registry's own error is what surfaces.
		for (const tags of [[], undefined, ['<none>:<none>'], ['acme/app:-dockhand-pending']]) {
			const t = resolveRegistryScanTarget(ID, tags, parseRegistry);
			expect(t.ref).toBe(ID);
			expect(t.authority).toBe(null);
		}
	});

	test('a plain tag is untouched and resolves its own registry', () => {
		expect(resolveRegistryScanTarget('nginx:1.27', undefined, parseRegistry)).toEqual({
			ref: 'nginx:1.27',
			registry: 'index.docker.io',
			authority: null,
			resolved: false,
			unresolvableId: false
		});
		const g = resolveRegistryScanTarget('ghcr.io/acme/app:1.0', undefined, parseRegistry);
		expect(g.authority).toBe('ghcr.io');
	});
});

describe('the registry preference is not cleared by one daemon success', () => {
	test('a marked env stays marked - blob loss is per-image', () => {
		// A small image exporting fine proves nothing about a store that loses blobs on a
		// large one, so releasing the env would send the next scan back through the doomed
		// export and thrash between the two paths.
		const m = new RegistryFallbackMemory();
		m.markBroken(5);
		expect(m.prefersRegistry(5)).toBe(true);
		m.clear();
		expect(m.prefersRegistry(5)).toBe(false);
	});

	test('the memory exposes no per-env release', () => {
		// A per-env clear is what made the env thrash; it must not come back silently.
		expect((new RegistryFallbackMemory() as Record<string, unknown>).clearEnv).toBeUndefined();
	});
});

describe('registry-first wiring in scanner.ts', () => {
	/** The registry-first branch: from the prefersRegistry test to the end of its block. */
	function preferBranch(): string {
		const start = scannerSrc.indexOf('prefersRegistry(envId)');
		expect(start).toBeGreaterThan(-1);
		const after = scannerSrc.indexOf('\n\ttry {', start);
		expect(after).toBeGreaterThan(start);
		return scannerSrc.slice(start, after);
	}

	test('the registry is tried first and the daemon is the fallback', () => {
		// Order matters: the whole point is to skip the doomed export, with the daemon
		// only as the stand-in for a ref no registry can answer.
		const b = preferBranch();
		expect(b.indexOf('run(true)')).toBeGreaterThan(-1);
		expect(b.indexOf('run(false)')).toBeGreaterThan(b.indexOf('run(true)'));
	});

	test('both decisions are delegated to the core, not reimplemented inline', () => {
		expect(preferBranch()).toContain('chooseReportedError(');
		expect(scannerSrc).toContain('resolveRegistryScanTarget(');
	});

	test('the daemon-first path still marks a broken env', () => {
		// The original fallback must survive: a blob-export failure still switches the env
		// to registry-first, which is what makes the doomed docker save skippable.
		expect(scannerSrc).toContain('markBroken(envId)');
		expect(scannerSrc).toContain('isDaemonExportFailure(scanErrorOutput(error))');
	});

	test('both failure branches classify on the full output, not the truncated message', () => {
		// The helper message is cut to ~1000 chars; the export-bug signature lands after
		// that, so the fallback must classify on scanErrorOutput (the untruncated stderr),
		// not the Error message. scanner.ts is not importable under bun, so this is the
		// only guard on the wiring - a revert to error.message would pass unit tests but
		// silently reinstate the bug.
		expect(scannerSrc).toContain('isDaemonExportFailure(scanErrorOutput(error))');
		expect(preferBranch()).toContain('chooseReportedError(rmsg, scanErrorOutput(daemonError))');
	});
});

describe('whether the inspect round-trip is worth paying for', () => {
	test('only a bare image ID needs RepoTags', () => {
		// The inspect is a remote call; a tag already names its repository.
		expect(needsRepoTags('sha256:' + 'a'.repeat(64))).toBe(true);
		expect(needsRepoTags('a'.repeat(64))).toBe(true);
		expect(needsRepoTags('nginx:1.27')).toBe(false);
		expect(needsRepoTags('nginx:latest-dockhand-pending')).toBe(false);
		expect(needsRepoTags('registry.bor6.pl:5000/team/app:v2')).toBe(false);
		expect(needsRepoTags('nginx@sha256:' + 'b'.repeat(64))).toBe(false);
		// Near misses: 63 and 65 hex are not image IDs.
		expect(needsRepoTags('a'.repeat(63))).toBe(false);
		expect(needsRepoTags('a'.repeat(65))).toBe(false);
	});

	test('the flags describe what happened to the ref', () => {
		const ID = 'sha256:' + 'c'.repeat(64);
		const hit = resolveRegistryScanTarget(ID, ['nginx:1.27-dockhand-pending'], parseRegistry);
		expect(hit.resolved).toBe(true);
		expect(hit.unresolvableId).toBe(false);

		const miss = resolveRegistryScanTarget(ID, [], parseRegistry);
		expect(miss.resolved).toBe(false);
		expect(miss.unresolvableId).toBe(true);

		// A plain tag was never an ID, so it is neither resolved nor unresolvable.
		const tag = resolveRegistryScanTarget('nginx:1.27', undefined, parseRegistry);
		expect(tag.resolved).toBe(false);
		expect(tag.unresolvableId).toBe(false);
	});
});
