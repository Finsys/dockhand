import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	areSocketConfigsEquivalent,
	normalizeSocketPath,
	hasConnectionFieldChanges,
	type EnvironmentConnectionInput
} from '../src/lib/utils/docker-environment-uniqueness';
import { cleanPem } from '../src/lib/utils/pem';

describe('normalizeSocketPath', () => {
	it('returns the original path when the socket does not exist', () => {
		assert.equal(normalizeSocketPath('/tmp/nonexistent-dockhand.sock'), '/tmp/nonexistent-dockhand.sock');
	});

	it('resolves existing paths through realpath', () => {
		const exists = (path: string) => path === '/var/run/docker.sock';
		const realpath = () => '/run/docker.sock';
		assert.equal(normalizeSocketPath('/var/run/docker.sock', exists, realpath), '/run/docker.sock');
	});
});

describe('areSocketConfigsEquivalent', () => {
	const socketConfig = (socketPath: string): EnvironmentConnectionInput => ({
		connectionType: 'socket',
		socketPath
	});

	it('returns true for identical socket paths', () => {
		assert.equal(
			areSocketConfigsEquivalent(
				socketConfig('/var/run/docker.sock'),
				socketConfig('/var/run/docker.sock')
			),
			true
		);
	});

	it('returns true when paths resolve to the same socket', () => {
		const exists = (path: string) => path === '/var/run/docker.sock' || path === '/run/docker.sock';
		const realpath = (path: string) => (path === '/var/run/docker.sock' ? '/run/docker.sock' : path);

		assert.equal(
			areSocketConfigsEquivalent(
				socketConfig('/var/run/docker.sock'),
				socketConfig('/run/docker.sock'),
				exists,
				realpath
			),
			true
		);
	});

	it('returns false when connection types differ', () => {
		assert.equal(
			areSocketConfigsEquivalent(
				socketConfig('/var/run/docker.sock'),
				{ connectionType: 'direct', host: '127.0.0.1', port: 2375 }
			),
			false
		);
	});

	it('returns false for different socket paths', () => {
		assert.equal(
			areSocketConfigsEquivalent(
				socketConfig('/var/run/docker.sock'),
				socketConfig('/run/podman/podman.sock')
			),
			false
		);
	});
});

describe('hasConnectionFieldChanges', () => {
	const storedPem = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----';

	it('ignores PEM whitespace differences', () => {
		assert.equal(
			hasConnectionFieldChanges(
				{ tlsCa: storedPem },
				{ tlsCa: '  -----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n  ' },
				cleanPem
			),
			false
		);
	});

	it('detects actual PEM content changes', () => {
		assert.equal(
			hasConnectionFieldChanges(
				{ tlsCa: storedPem },
				{ tlsCa: '-----BEGIN CERTIFICATE-----\nDIFFERENT\n-----END CERTIFICATE-----' },
				cleanPem
			),
			true
		);
	});

	it('detects non-PEM connection field changes', () => {
		assert.equal(
			hasConnectionFieldChanges({ host: 'docker.local' }, { host: 'other.local' }, cleanPem),
			true
		);
	});
});
