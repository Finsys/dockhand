import { describe, it, expect } from 'bun:test';
import { dockerTlsEnv } from '../src/lib/server/docker-tls-env';

describe('dockerTlsEnv (#1557 - login/compose speak TLS to an HTTPS daemon)', () => {
	it('enables TLS and points at the cert dir', () => {
		const env = dockerTlsEnv('/data/tmp/tls-x');
		expect(env.DOCKER_TLS).toBe('1');
		expect(env.DOCKER_CERT_PATH).toBe('/data/tmp/tls-x');
	});

	it('verifies the server cert by default (skipVerify unset -> DOCKER_TLS_VERIFY=1)', () => {
		expect(dockerTlsEnv('/d').DOCKER_TLS_VERIFY).toBe('1');
		expect(dockerTlsEnv('/d', false).DOCKER_TLS_VERIFY).toBe('1');
	});

	it('skips verification when asked (skipVerify=true -> DOCKER_TLS_VERIFY=0)', () => {
		expect(dockerTlsEnv('/d', true).DOCKER_TLS_VERIFY).toBe('0');
	});
});
