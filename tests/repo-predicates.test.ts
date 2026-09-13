/**
 * Unit tests for the shared repo/environment predicates
 * (src/lib/shared/repo-predicates.ts). Consolidates the copies five call sites
 * used to hand-inline. #1316: a local-path repo on a remote/direct env is no
 * longer blocked (the backup helper self-checks at run time); the predicate is
 * now advisory-only for the UI hint.
 */
import { describe, test, expect } from 'bun:test';
import { isLocalRepo, isRemoteEnvironment, localRepoNeedsSameHost, backendSupportsTls } from '../src/lib/shared/repo-predicates';

describe('isLocalRepo', () => {
	test('absolute and relative filesystem paths are local', () => {
		expect(isLocalRepo('/mnt/nas/backups')).toBe(true);
		expect(isLocalRepo('./data/repo')).toBe(true);
	});
	test('cloud / rest backends are not local', () => {
		expect(isLocalRepo('s3:s3.amazonaws.com/bucket')).toBe(false);
		expect(isLocalRepo('rest:http://host:8000/')).toBe(false);
		expect(isLocalRepo('b2:bucket:path')).toBe(false);
	});
});

describe('isRemoteEnvironment', () => {
	test('hawser envs are remote', () => {
		expect(isRemoteEnvironment({ connectionType: 'hawser-standard' })).toBe(true);
		expect(isRemoteEnvironment({ connectionType: 'hawser-edge' })).toBe(true);
	});
	test('direct-with-host is remote (this includes a socket-proxy env)', () => {
		expect(isRemoteEnvironment({ connectionType: 'direct', host: '192.168.1.221' })).toBe(true);
	});
	test('socket env and empty env are local', () => {
		expect(isRemoteEnvironment({ connectionType: 'socket' })).toBe(false);
		expect(isRemoteEnvironment(undefined)).toBe(false);
		expect(isRemoteEnvironment({ connectionType: 'direct', host: null })).toBe(false);
	});
});

describe('localRepoNeedsSameHost (#1316 advisory)', () => {
	const localDest = { repository: '/mnt/nas/backups' };
	const cloudDest = { repository: 's3:s3.amazonaws.com/bucket' };
	const socketEnv = { connectionType: 'socket' };
	const proxyEnv = { connectionType: 'direct', host: '192.168.1.221' };

	test('local repo + remote/proxy env => needs same host (advisory true)', () => {
		expect(localRepoNeedsSameHost(localDest, proxyEnv)).toBe(true);
	});
	test('local repo + socket env => fine (helper runs on Dockhand host)', () => {
		expect(localRepoNeedsSameHost(localDest, socketEnv)).toBe(false);
	});
	test('cloud repo => never needs same host', () => {
		expect(localRepoNeedsSameHost(cloudDest, proxyEnv)).toBe(false);
		expect(localRepoNeedsSameHost(cloudDest, socketEnv)).toBe(false);
	});
	test('no env (undefined) => not flagged', () => {
		expect(localRepoNeedsSameHost(localDest, undefined)).toBe(false);
	});
});

describe('backendSupportsTls (destination TLS fields visibility)', () => {
	test('s3 and rest support TLS (self-hostable over HTTPS with a private CA)', () => {
		expect(backendSupportsTls('s3')).toBe(true);
		expect(backendSupportsTls('rest')).toBe(true);
	});

	test('local path and managed clouds do NOT show TLS fields', () => {
		expect(backendSupportsTls('local')).toBe(false);
		expect(backendSupportsTls('b2')).toBe(false);
		expect(backendSupportsTls('azure')).toBe(false);
		expect(backendSupportsTls('gs')).toBe(false);
	});

	test('editing a non-TLS backend that already has a cert stored still shows the section', () => {
		// A destination created before this filter that carries a CA must not have its
		// stored cert hidden on edit.
		expect(backendSupportsTls('gs', { isEditing: true, hasStoredCert: true })).toBe(true);
		expect(backendSupportsTls('local', { isEditing: true, hasStoredCert: true })).toBe(true);
	});

	test('editing without a stored cert keeps the section hidden for non-TLS backends', () => {
		expect(backendSupportsTls('gs', { isEditing: true, hasStoredCert: false })).toBe(false);
		expect(backendSupportsTls('azure', { isEditing: true, hasStoredCert: false })).toBe(false);
	});

	test('creating (not editing) never shows TLS for a non-TLS backend regardless of flags', () => {
		expect(backendSupportsTls('local', { isEditing: false, hasStoredCert: true })).toBe(false);
	});
});
