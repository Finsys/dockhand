/**
 * Unit tests for the shared repo/environment predicates
 * (src/lib/shared/repo-predicates.ts). Consolidates the copies five call sites
 * used to hand-inline. #1316: a local-path repo on a remote/direct env is no
 * longer blocked (the backup helper self-checks at run time); the predicate is
 * now advisory-only for the UI hint.
 */
import { describe, test, expect } from 'bun:test';
import { isLocalRepo, isRemoteEnvironment, localRepoNeedsSameHost } from '../src/lib/shared/repo-predicates';

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
