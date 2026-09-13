/**
 * Regression tests for the restic-subprocess hardening from the 2026-06-26
 * HIGH audit: env allowlist (#1), envVars injection block (#32), and the
 * restic flag allowlist (#34). Pure helpers → exercised directly here.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildResticEnv, sanitizeResticFlags, filterCloudEnvVars, isSafeWebhookUrl, fireWebhook } from '../src/lib/server/backups/helpers';

describe('isSafeWebhookUrl — SSRF guard (audit #46)', () => {
	it('allows public http/https URLs', () => {
		assert.equal(isSafeWebhookUrl('https://hooks.example.com/x').ok, true);
		assert.equal(isSafeWebhookUrl('http://93.184.216.34/notify').ok, true);
	});
	it('blocks the cloud metadata IP and private/loopback/link-local', () => {
		for (const u of [
			'http://169.254.169.254/latest/meta-data/',
			'http://127.0.0.1:6379/',
			'http://localhost/x',
			'http://10.0.0.5/x',
			'http://192.168.1.1/x',
			'http://172.16.0.9/x',
			'http://[::1]/x'
		]) {
			assert.equal(isSafeWebhookUrl(u).ok, false, `should block ${u}`);
		}
	});
	it('blocks non-http schemes and garbage', () => {
		assert.equal(isSafeWebhookUrl('file:///etc/passwd').ok, false);
		assert.equal(isSafeWebhookUrl('gopher://x').ok, false);
		assert.equal(isSafeWebhookUrl('not a url').ok, false);
	});
});

describe('filterCloudEnvVars — container envVars allowlist (audit #30)', () => {
	it('keeps cloud credential vars, drops PATH/LD_PRELOAD injection', () => {
		const out = filterCloudEnvVars({
			AWS_ACCESS_KEY_ID: 'AKIA', B2_ACCOUNT_KEY: 'k', AZURE_ACCOUNT_KEY: 'z',
			PATH: '/evil', LD_PRELOAD: '/tmp/x.so', HOME: '/root',
			RCLONE_CONFIG_PASS: 'p'  // rclone backend removed → its prefix is no longer allowlisted
		});
		assert.equal(out.AWS_ACCESS_KEY_ID, 'AKIA');
		assert.equal(out.B2_ACCOUNT_KEY, 'k');
		assert.equal(out.AZURE_ACCOUNT_KEY, 'z');
		assert.equal(out.PATH, undefined);
		assert.equal(out.LD_PRELOAD, undefined);
		assert.equal(out.HOME, undefined);
		assert.equal(out.RCLONE_CONFIG_PASS, undefined);
	});
	it('handles empty/undefined input', () => {
		assert.deepEqual(filterCloudEnvVars({}), {});
		assert.deepEqual(filterCloudEnvVars(undefined as any), {});
	});
});

describe('buildResticEnv — env allowlist (audit #1, #32)', () => {
	const procEnv = {
		PATH: '/usr/bin',
		HOME: '/root',
		HTTPS_PROXY: 'http://proxy:3128',
		ENCRYPTION_KEY: 'super-secret-master-key',
		DATABASE_URL: 'postgres://user:pw@db/dockhand',
		SOME_OTHER_SECRET: 'nope'
	};

	it('passes through the allowlisted base vars', () => {
		const env = buildResticEnv(procEnv, { repository: 'rest:http://x', password: 'pw' });
		assert.equal(env.PATH, '/usr/bin');
		assert.equal(env.HOME, '/root');
		assert.equal(env.HTTPS_PROXY, 'http://proxy:3128');
	});

	it('NEVER leaks ENCRYPTION_KEY / DATABASE_URL / other process secrets', () => {
		const env = buildResticEnv(procEnv, { repository: 'rest:http://x', password: 'pw' });
		assert.equal(env.ENCRYPTION_KEY, undefined);
		assert.equal(env.DATABASE_URL, undefined);
		assert.equal(env.SOME_OTHER_SECRET, undefined);
	});

	it('sets the restic repo + password', () => {
		const env = buildResticEnv(procEnv, { repository: 'rest:http://repo', password: 's3cret' });
		assert.equal(env.RESTIC_REPOSITORY, 'rest:http://repo');
		assert.equal(env.RESTIC_PASSWORD, 's3cret');
	});

	it('allows cloud credential envVars but blocks PATH/LD_PRELOAD injection', () => {
		const env = buildResticEnv(procEnv, {
			repository: 'r', password: 'p',
			envVars: {
				AWS_ACCESS_KEY_ID: 'AKIA', AWS_SECRET_ACCESS_KEY: 'shh', B2_ACCOUNT_ID: 'b2',
				RCLONE_CONFIG_PASS: 'x',  // rclone backend removed → prefix no longer allowlisted
				PATH: '/evil/bin', LD_PRELOAD: '/tmp/evil.so', LD_LIBRARY_PATH: '/tmp'
			}
		});
		assert.equal(env.AWS_ACCESS_KEY_ID, 'AKIA');
		assert.equal(env.AWS_SECRET_ACCESS_KEY, 'shh');
		assert.equal(env.B2_ACCOUNT_ID, 'b2');
		assert.equal(env.RCLONE_CONFIG_PASS, undefined);
		// injection attempts via envVars must NOT override the process PATH etc.
		assert.equal(env.PATH, '/usr/bin');
		assert.equal(env.LD_PRELOAD, undefined);
		assert.equal(env.LD_LIBRARY_PATH, undefined);
	});

	it('points RESTIC_CACHE_DIR at DATA_DIR/.restic-cache (durable, survives redeploy)', () => {
		const env = buildResticEnv({ ...procEnv, DATA_DIR: '/app/data' }, { repository: 'r', password: 'p' });
		assert.equal(env.RESTIC_CACHE_DIR, '/app/data/.restic-cache');
	});

	it('defaults the cache dir to /app/data when DATA_DIR is unset', () => {
		const env = buildResticEnv(procEnv, { repository: 'r', password: 'p' });
		assert.equal(env.RESTIC_CACHE_DIR, '/app/data/.restic-cache');
	});

	it('an operator-set RESTIC_CACHE_DIR wins', () => {
		const env = buildResticEnv({ ...procEnv, RESTIC_CACHE_DIR: '/custom/cache' }, { repository: 'r', password: 'p' });
		assert.equal(env.RESTIC_CACHE_DIR, '/custom/cache');
	});
});

describe('sanitizeResticFlags — flag allowlist (audit #34)', () => {
	it('accepts allowlisted flags with and without values', () => {
		assert.deepEqual(sanitizeResticFlags('--no-cache --limit-upload=1024'), ['--no-cache', '--limit-upload=1024']);
	});

	it('accepts a SPACE-separated value-taking flag (the value is not a flag)', () => {
		// `--retry-lock 10m` — the `10m` is the flag's value, not a positional. This
		// used to be wrongly rejected as "Disallowed restic flag: 10m".
		assert.deepEqual(sanitizeResticFlags('--verbose --retry-lock 10m'), ['--verbose', '--retry-lock', '10m']);
		assert.deepEqual(sanitizeResticFlags('--compression max'), ['--compression', 'max']);
	});

	it('a value-taking flag missing its value is rejected', () => {
		assert.throws(() => sanitizeResticFlags('--retry-lock'), /missing its value/);
	});

	it('returns [] for empty/undefined/whitespace', () => {
		assert.deepEqual(sanitizeResticFlags(''), []);
		assert.deepEqual(sanitizeResticFlags(undefined), []);
		assert.deepEqual(sanitizeResticFlags('   '), []);
	});

	it('rejects dangerous flags like --option and --password-command', () => {
		assert.throws(() => sanitizeResticFlags('--option=s3.storage-class=X'), /Disallowed restic flag/);
		assert.throws(() => sanitizeResticFlags('--password-command=cat /etc/shadow'), /Disallowed restic flag/);
	});

	it('rejects a bare non-flag argument (no leading --)', () => {
		assert.throws(() => sanitizeResticFlags('snapshots'), /Disallowed restic flag/);
		assert.throws(() => sanitizeResticFlags('--no-cache evilpositional'), /Disallowed restic flag/);
	});
});

describe('fireWebhook — per-config backup webhook delivery (audit #6/#46/#54)', () => {
	// Injectable deps so we exercise the guard/branch logic with no real network/DNS.
	function harness(over: Partial<Parameters<typeof fireWebhook>[2]> = {}) {
		const calls: Array<{ url: string; init?: any }> = [];
		const logs: string[] = [];
		const deps = {
			fetch: (async (url: any, init?: any) => { calls.push({ url: String(url), init }); return new Response('ok'); }) as any,
			resolveHost: async () => ['93.184.216.34'], // a public IP by default
			log: (m: string) => logs.push(m),
			now: () => '2026-01-01T00:00:00.000Z',
			...over,
		};
		return { calls, logs, deps };
	}

	it('POSTs a JSON body (with a stamped timestamp) to a safe public URL', async () => {
		const { calls, deps } = harness();
		await fireWebhook('https://hooks.example.com/backup', { event: 'backup_success', target: 'web' }, deps);
		assert.equal(calls.length, 1);
		assert.equal(calls[0].init.method, 'POST');
		const body = JSON.parse(calls[0].init.body);
		assert.equal(body.event, 'backup_success');
		assert.equal(body.target, 'web');
		assert.equal(body.timestamp, '2026-01-01T00:00:00.000Z');
	});

	it('blocks a loopback / cloud-metadata literal-IP URL BEFORE any fetch (SSRF)', async () => {
		for (const bad of ['http://127.0.0.1/x', 'http://169.254.169.254/latest/meta-data/']) {
			const { calls, logs, deps } = harness();
			await fireWebhook(bad, { event: 'backup_success' }, deps);
			assert.equal(calls.length, 0, `must not fetch ${bad}`);
			assert.ok(logs.some(l => /blocked/i.test(l)));
		}
	});

	it('ALLOWS a self-hosted LAN receiver (192.168.x / 10.x) — webhook trust model', async () => {
		// Webhooks are notification-grade: a LAN catcher (ntfy/healthchecks on the
		// user network, e.g. webhook.lan.example -> 10.0.0.5) must be reachable.
		const { calls, deps } = harness({ resolveHost: async () => ['10.0.0.5'] });
		await fireWebhook('https://webhook.lan.example/backup', { event: 'backup_success' }, deps);
		assert.equal(calls.length, 1, 'a LAN webhook receiver must be allowed');
		assert.equal(calls[0].init.method, 'POST');
	});

	it('blocks a public hostname that RESOLVES to loopback/metadata (DNS rebinding #54)', async () => {
		const { calls, logs, deps } = harness({ resolveHost: async () => ['169.254.169.254'] });
		await fireWebhook('https://sneaky.example.com/x', { event: 'backup_success' }, deps);
		assert.equal(calls.length, 0, 'must not connect when the host resolves to a dangerous IP');
		assert.ok(logs.some(l => /disallowed address|blocked/i.test(l)));
	});

	it('falls back to a bare GET when the POST throws', async () => {
		let n = 0;
		const seen: string[] = [];
		const deps = harness().deps;
		deps.fetch = (async (_url: any, init?: any) => {
			seen.push(init?.method ?? 'GET');
			if (n++ === 0) throw new Error('POST refused');
			return new Response('ok');
		}) as any;
		await fireWebhook('https://hooks.example.com/ping', { event: 'backup_success' }, deps);
		assert.deepEqual(seen, ['POST', 'GET']);
	});

	it('never throws even when both POST and GET fail (fire-and-forget)', async () => {
		const deps = harness().deps;
		deps.fetch = (async () => { throw new Error('network down'); }) as any;
		// Must resolve, not reject — a webhook failure can never break a backup.
		await fireWebhook('https://hooks.example.com/x', { event: 'backup_success' }, deps);
	});

	it('blocks (fail-closed) and never fetches when DNS resolution itself throws', async () => {
		// If we can't resolve the host, we can't prove it's safe → block, don't fetch.
		const { calls, logs, deps } = harness({
			resolveHost: async () => { throw new Error('NXDOMAIN'); },
		});
		await fireWebhook('https://unresolvable.example.com/x', { event: 'backup_success' }, deps);
		assert.equal(calls.length, 0, 'must not fetch when the host can not be resolved');
		assert.ok(logs.some(l => /could not resolve|blocked/i.test(l)));
	});
});
