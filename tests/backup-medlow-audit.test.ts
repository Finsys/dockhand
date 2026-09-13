/**
 * Regression tests for the 2026-07-02 medium/low backup-audit fixes — the pure,
 * extractable pieces. Behavioral/route/DB-bound findings are exercised via the
 * shared helpers they were built on.
 *
 *   #37  parsePoliciesJson       — safe parse, logs once, degrades to {}
 *   #13  validateRetention       — reject negative/fractional/string/out-of-range
 *   #7/#53 isAllowedRepository /  — scheme allowlist + SSRF host reject
 *          privateIpReason
 *   #6   sanitizeWebhookUrlForLog — strip query + redact path, fail closed
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	parsePoliciesJson,
	validateRetention,
	isAllowedRepository,
	privateIpReason,
	sanitizeWebhookUrlForLog,
	classifyBackupError
} from '../src/lib/server/backups/helpers';

describe('parsePoliciesJson — safe policy parse (audit #37)', () => {
	it('parses valid JSON', () => {
		assert.deepEqual(parsePoliciesJson('{"autoUnlock":true}'), { autoUnlock: true });
	});
	it('null/empty → {}', () => {
		assert.deepEqual(parsePoliciesJson(null), {});
		assert.deepEqual(parsePoliciesJson(undefined), {});
		assert.deepEqual(parsePoliciesJson(''), {});
	});
	it('malformed JSON → {} (does not throw)', () => {
		assert.deepEqual(parsePoliciesJson('{not json'), {});
	});
});

describe('validateRetention — keep-* bounds (audit #13)', () => {
	it('null/undefined retention is allowed (optional)', () => {
		assert.equal(validateRetention(null).ok, true);
		assert.equal(validateRetention(undefined).ok, true);
	});
	it('accepts valid non-negative integers', () => {
		assert.equal(validateRetention({ keepLast: 3, keepDaily: 7, keepMonthly: 0 }).ok, true);
	});
	it('rejects negative, fractional, string, NaN, Infinity', () => {
		assert.equal(validateRetention({ keepLast: -1 }).ok, false);
		assert.equal(validateRetention({ keepDaily: 0.5 }).ok, false);
		assert.equal(validateRetention({ keepWeekly: '5' }).ok, false);
		assert.equal(validateRetention({ keepMonthly: NaN }).ok, false);
		assert.equal(validateRetention({ keepYearly: Infinity }).ok, false);
	});
	it('rejects out-of-range (> 10000)', () => {
		assert.equal(validateRetention({ keepLast: 10001 }).ok, false);
		assert.equal(validateRetention({ keepLast: 10000 }).ok, true);
	});
	it('rejects a non-object', () => {
		assert.equal(validateRetention('nope').ok, false);
		assert.equal(validateRetention([1, 2]).ok, false);
	});
	it('names the offending field in the reason', () => {
		const r = validateRetention({ keepDaily: -3 });
		assert.equal(r.ok, false);
		assert.match((r as { reason: string }).reason, /keepDaily/);
	});
});

describe('isAllowedRepository — scheme allowlist (audit #7/#53)', () => {
	it('accepts local absolute paths and known schemes', () => {
		for (const r of ['/srv/backups', 's3:s3.amazonaws.com/bucket', 'rest:https://r.example/repo', 'b2:bucket', 'azure:container', 'gs:bucket']) {
			assert.equal(isAllowedRepository(r), true, `should allow ${r}`);
		}
	});
	it('rejects unknown schemes, relative paths, and empty', () => {
		// rclone:/sftp:/swift: were removed from the allowlist (unfinished/untested backends)
		for (const r of ['s3//typo', 'ftp://host/x', './relative', 'file:///etc/passwd', 'rclone:remote:path', 'sftp:user@host:/path', 'swift:container', '', null, undefined]) {
			assert.equal(isAllowedRepository(r as any), false, `should reject ${r}`);
		}
	});
});

describe('privateIpReason — SSRF range check (audit #46/#53/#54)', () => {
	it('flags loopback / private / link-local / metadata IPv4', () => {
		for (const h of ['127.0.0.1', '10.0.0.5', '192.168.1.1', '172.16.0.9', '169.254.169.254', '0.0.0.0']) {
			assert.ok(privateIpReason(h), `should flag ${h}`);
		}
	});
	it('flags IPv6 loopback / ULA / link-local and v4-mapped metadata', () => {
		assert.ok(privateIpReason('::1'));
		assert.ok(privateIpReason('fd00::1'));
		assert.ok(privateIpReason('fe80::1'));
		assert.ok(privateIpReason('::ffff:169.254.169.254'));
	});
	it('flags v4-mapped IPv6 in HEX / expanded form (new URL normalizes to these)', () => {
		// The real bypass: new URL('http://[::ffff:169.254.169.254]') -> ::ffff:a9fe:a9fe
		assert.ok(privateIpReason('::ffff:a9fe:a9fe'), 'metadata (hex)');
		assert.ok(privateIpReason('::ffff:7f00:1'), 'loopback (hex)');
		assert.ok(privateIpReason('0:0:0:0:0:ffff:127.0.0.1'), 'loopback (expanded)');
		assert.ok(privateIpReason('::'), 'unspecified');
	});
	it('returns null for public IPs and hostnames', () => {
		assert.equal(privateIpReason('93.184.216.34'), null);
		assert.equal(privateIpReason('hooks.example.com'), null);
	});
});

describe('sanitizeWebhookUrlForLog — no secret leak (audit #6)', () => {
	it('strips the query string entirely', () => {
		const out = sanitizeWebhookUrlForLog('https://hook.example/notify?token=secret');
		assert.ok(!out.includes('secret'), 'must not contain the query secret');
		assert.ok(!out.includes('token'), 'must not contain the query key');
	});
	it('redacts trailing path segments (healthchecks-style uuid)', () => {
		const out = sanitizeWebhookUrlForLog('https://hc.example/ping/2f3d-uuid-secret');
		assert.ok(!out.includes('2f3d-uuid-secret'), 'must not contain the path secret');
		assert.match(out, /\/\*\*\*$/);
	});
	it('keeps just the origin when there is no path', () => {
		assert.equal(sanitizeWebhookUrlForLog('https://hook.example/'), 'https://hook.example');
	});
	it('fails closed on an unparseable URL', () => {
		assert.equal(sanitizeWebhookUrlForLog('not a url'), '<webhook>');
	});
});

describe('classifyBackupError — failure category vocabulary (audit #20)', () => {
	it('maps known restic failure signatures to codes', () => {
		assert.equal(classifyBackupError(new Error('restic timed out after 300s (killed by SIGTERM)')), 'RESTIC_TIMEOUT');
		assert.equal(classifyBackupError(new Error('wrong password or no key found')), 'WRONG_PASSWORD');
		assert.equal(classifyBackupError(new Error('repository is already locked exclusively')), 'REPO_LOCKED');
		assert.equal(classifyBackupError(new Error('dial tcp: lookup s3.example: no such host')), 'NETWORK');
	});
	it('maps a repo-not-initialized error via exitCode', () => {
		const e: any = new Error('repo'); e.exitCode = 10;
		assert.equal(classifyBackupError(e), 'REPO_NOT_INIT');
	});
	it('defaults to UNKNOWN and never throws', () => {
		assert.equal(classifyBackupError(new Error('something weird')), 'UNKNOWN');
		assert.equal(classifyBackupError(null), 'UNKNOWN');
		assert.equal(classifyBackupError(undefined), 'UNKNOWN');
	});
});
