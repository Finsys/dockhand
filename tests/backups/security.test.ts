/**
 * Unit tests for backups/security.ts — the path-containment + snapshot-path
 * guards, plus a sanity check that the re-exported hardened primitives still
 * reject the known-dangerous inputs (env leak, flag injection, SSRF).
 */
import { describe, it, expect } from 'bun:test';
import {
	isSafeVolumeInclude,
	assertSafeVolumeInclude,
	isPathWithin,
	assertTargetWithin,
	isSafePathSegment,
	buildResticEnv,
	sanitizeResticFlags,
	filterCloudEnvVars,
	isSafeWebhookUrl,
	unsafeRestoreTargetReason,
	assertSafeRestoreTarget,
} from '../../src/lib/server/backups/security';

describe('isSafeVolumeInclude (command-injection guard on restore includes)', () => {
	it('accepts plain /volumes/<name>', () => {
		expect(isSafeVolumeInclude('/volumes/data')).toBe(true);
		expect(isSafeVolumeInclude('/volumes/my-vol_1.2')).toBe(true);
	});
	it('accepts the bare /metadata dir (config-only snapshot restore)', () => {
		expect(isSafeVolumeInclude('/metadata')).toBe(true);
		// only the exact literal — no arbitrary subpath under /metadata
		expect(isSafeVolumeInclude('/metadata/evil')).toBe(false);
		expect(isSafeVolumeInclude('/metadata/')).toBe(false);
	});
	it('rejects anything with shell metacharacters or a different root', () => {
		expect(isSafeVolumeInclude('/volumes/$(id)')).toBe(false);
		expect(isSafeVolumeInclude('/volumes/a;rm -rf /')).toBe(false);
		expect(isSafeVolumeInclude('/volumes/a b')).toBe(false);
		expect(isSafeVolumeInclude('/etc/passwd')).toBe(false);
		expect(isSafeVolumeInclude('/volumes/')).toBe(false);
		expect(isSafeVolumeInclude('/volumes/../etc')).toBe(false);
	});
	it('assert variant throws on bad input', () => {
		expect(() => assertSafeVolumeInclude('/volumes/ok')).not.toThrow();
		expect(() => assertSafeVolumeInclude('/volumes/$(x)')).toThrow(/Unsafe restore include/);
	});
});

describe('isPathWithin (restore-target containment)', () => {
	it('accepts a path under the root, including the root itself', () => {
		expect(isPathWithin('/data/stacks', '/data/stacks')).toBe(true);
		expect(isPathWithin('/data/stacks', '/data/stacks/web')).toBe(true);
		expect(isPathWithin('/data/stacks', '/data/stacks/web/compose.yaml')).toBe(true);
	});
	it('rejects a sibling-prefix escape (the classic containment bug)', () => {
		// /data/stacks-evil is NOT under /data/stacks even though it shares the prefix
		expect(isPathWithin('/data/stacks', '/data/stacks-evil')).toBe(false);
	});
	it('rejects a traversal escape', () => {
		expect(isPathWithin('/data/stacks', '/data/stacks/../../etc/cron.d')).toBe(false);
		expect(isPathWithin('/data/stacks', '/etc/passwd')).toBe(false);
	});
	it('assert variant throws with a clear message', () => {
		expect(() => assertTargetWithin('/data/stacks', '/data/stacks/ok')).not.toThrow();
		expect(() => assertTargetWithin('/data/stacks', '/etc', 'stack dir')).toThrow(/stack dir.*outside/);
	});
});

describe('isSafePathSegment (name traversal guard)', () => {
	it('accepts a plain name', () => {
		expect(isSafePathSegment('web')).toBe(true);
		expect(isSafePathSegment('my-stack_1')).toBe(true);
	});
	it('rejects empty, separators, and dot-dot', () => {
		expect(isSafePathSegment('')).toBe(false);
		expect(isSafePathSegment('a/b')).toBe(false);
		expect(isSafePathSegment('a\\b')).toBe(false);
		expect(isSafePathSegment('..')).toBe(false);
		expect(isSafePathSegment('.')).toBe(false);
		expect(isSafePathSegment('a..b')).toBe(false);
	});
});

describe('re-exported hardened primitives still reject dangerous inputs', () => {
	it('buildResticEnv never leaks the master key / arbitrary process env', () => {
		const env = buildResticEnv(
			{ ENCRYPTION_KEY: 'secret', DATABASE_URL: 'postgres://x', PATH: '/usr/bin' },
			{ repository: 'repo', password: 'pw', envVars: {} }
		);
		expect(env.ENCRYPTION_KEY).toBeUndefined();
		expect(env.DATABASE_URL).toBeUndefined();
		expect(env.RESTIC_REPOSITORY).toBe('repo');
		expect(env.RESTIC_PASSWORD).toBe('pw');
	});
	it('buildResticEnv drops PATH/LD_PRELOAD injection via destination envVars', () => {
		const env = buildResticEnv(
			{},
			{ repository: 'r', password: 'p', envVars: { LD_PRELOAD: '/evil.so', PATH: '/evil', AWS_ACCESS_KEY_ID: 'ok' } }
		);
		expect(env.LD_PRELOAD).toBeUndefined();
		// a real cloud credential still passes the allowlist
		expect(env.AWS_ACCESS_KEY_ID).toBe('ok');
	});
	it('filterCloudEnvVars keeps cloud creds, drops the rest', () => {
		const out = filterCloudEnvVars({ AWS_SECRET_ACCESS_KEY: 'k', EVIL: 'x', PATH: '/evil' });
		expect(out.AWS_SECRET_ACCESS_KEY).toBe('k');
		expect(out.EVIL).toBeUndefined();
		expect(out.PATH).toBeUndefined();
	});
	it('sanitizeResticFlags rejects dangerous flags, accepts allowlisted ones', () => {
		expect(sanitizeResticFlags('--limit-upload=1000')).toEqual(['--limit-upload=1000']);
		expect(() => sanitizeResticFlags('--password-command=evil')).toThrow();
		expect(() => sanitizeResticFlags('--option=x')).toThrow();
	});
	it('sanitizeResticFlags handles space-separated values without treating them as flags', () => {
		// The value token after a space-separated value-taking flag legitimately
		// does not start with `--` and must NOT be rejected as a bare arg.
		expect(sanitizeResticFlags('--retry-lock 10m')).toEqual(['--retry-lock', '10m']);
		// A value-taking flag followed by another flag: value consumed, flag kept.
		expect(sanitizeResticFlags('--limit-upload 500 --no-cache')).toEqual(['--limit-upload', '500', '--no-cache']);
		expect(sanitizeResticFlags('--compression max --json')).toEqual(['--compression', 'max', '--json']);
	});
	it('sanitizeResticFlags rejects a value-taking flag with no value, and bare non-flag args', () => {
		expect(() => sanitizeResticFlags('--retry-lock')).toThrow(/missing its value/);
		// A bare token that isn't the value of a preceding value-taking flag is an arg, not a flag.
		expect(() => sanitizeResticFlags('evil')).toThrow(/Disallowed/);
		// The allowlist is case-sensitive: an upper-cased known flag is NOT allowed.
		expect(() => sanitizeResticFlags('--LIMIT-UPLOAD=1')).toThrow(/Disallowed/);
	});
	it('sanitizeResticFlags treats empty / whitespace / nullish input as no flags', () => {
		expect(sanitizeResticFlags('')).toEqual([]);
		expect(sanitizeResticFlags('   ')).toEqual([]);
		expect(sanitizeResticFlags(null)).toEqual([]);
		expect(sanitizeResticFlags(undefined)).toEqual([]);
	});
	it('isSafeWebhookUrl blocks loopback/private/metadata and non-http', () => {
		expect(isSafeWebhookUrl('https://example.com/hook').ok).toBe(true);
		expect(isSafeWebhookUrl('http://169.254.169.254/latest').ok).toBe(false);
		expect(isSafeWebhookUrl('http://127.0.0.1/x').ok).toBe(false);
		expect(isSafeWebhookUrl('http://10.0.0.5/x').ok).toBe(false);
		expect(isSafeWebhookUrl('file:///etc/passwd').ok).toBe(false);
	});
});

describe('unsafeRestoreTargetReason (new-location targetPath containment)', () => {
	it('accepts legitimate operator-chosen restore locations', () => {
		for (const p of ['/mnt/restore', '/srv/appA/data', '/home/user/backup', '/opt/data', '/data/x', '/usr/local/share/app']) {
			expect(unsafeRestoreTargetReason(p)).toBeNull();
		}
	});

	it('rejects protected system roots and their children', () => {
		for (const p of ['/', '/etc', '/etc/cron.d', '/root/.ssh', '/var/run/docker.sock', '/bin', '/usr/../etc', '/var/lib/docker/volumes']) {
			expect(unsafeRestoreTargetReason(p)).not.toBeNull();
		}
	});

	it('rejects relative, empty, and traversal-escaping paths', () => {
		expect(unsafeRestoreTargetReason('')).not.toBeNull();
		expect(unsafeRestoreTargetReason('relative/path')).not.toBeNull();
		expect(unsafeRestoreTargetReason('/srv/../etc')).not.toBeNull();   // resolves into /etc
		expect(unsafeRestoreTargetReason('/etc/')).not.toBeNull();          // trailing slash normalizes
	});

	it('assertSafeRestoreTarget throws for unsafe, passes for safe', () => {
		expect(() => assertSafeRestoreTarget('/etc/passwd')).toThrow();
		expect(() => assertSafeRestoreTarget('/')).toThrow();
		expect(() => assertSafeRestoreTarget('/mnt/restore')).not.toThrow();
	});
});
