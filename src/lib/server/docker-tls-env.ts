/**
 * The Docker CLI TLS env vars for talking to an HTTPS daemon, given a directory that
 * already holds ca/cert/key.pem. Used by both the compose spawn and the registry-login
 * spawn so `docker login` speaks TLS to a mTLS proxy on :2376 instead of plaintext HTTP
 * (#1557). Pure so the DOCKER_TLS_VERIFY mapping is unit-testable without spawning docker.
 */
export function dockerTlsEnv(certDir: string, skipVerify?: boolean): {
	DOCKER_TLS: string;
	DOCKER_CERT_PATH: string;
	DOCKER_TLS_VERIFY: string;
} {
	return {
		DOCKER_TLS: '1',
		DOCKER_CERT_PATH: certDir,
		DOCKER_TLS_VERIFY: skipVerify ? '0' : '1'
	};
}
