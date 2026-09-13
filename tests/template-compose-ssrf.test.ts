/**
 * SSRF guard for the template compose-fetch endpoint (POST /api/templates/compose).
 *
 * For a stack template the server fetches `repository.url + stackfile` and returns
 * the body. That URL is fully user-controlled, so without a guard an authenticated
 * user could point it at loopback / private / cloud-metadata hosts and read the
 * response (a response-disclosing SSRF). The handler gates the fetch with
 * isSafeWebhookUrl (strict: block all private ranges - a compose template always
 * lives on a public host) and refuses to follow redirects. This test pins the
 * guard behaviour the endpoint relies on.
 */
import { describe, test, expect } from 'bun:test';
import { isSafeWebhookUrl } from '../src/lib/server/url-safety';

describe('template compose-fetch SSRF guard', () => {
	test('blocks cloud metadata, loopback and private ranges', () => {
		const blocked = [
			'http://169.254.169.254/latest/meta-data/iam/security-credentials/', // AWS metadata
			'http://localhost:8080/internal',
			'http://127.0.0.1/admin',
			'http://[::1]/admin',
			'http://0.0.0.0/x',
			'http://10.0.0.5/service',
			'http://192.168.1.1/router',
			'http://172.16.0.1/x',
		];
		for (const url of blocked) {
			expect(isSafeWebhookUrl(url).ok).toBe(false);
		}
	});

	test('blocks non-http(s) schemes', () => {
		for (const url of ['file:///etc/passwd', 'gopher://x/', 'ftp://host/f']) {
			expect(isSafeWebhookUrl(url).ok).toBe(false);
		}
	});

	test('allows a normal public compose URL', () => {
		expect(isSafeWebhookUrl('https://raw.githubusercontent.com/owner/repo/main/compose.yml').ok).toBe(true);
		expect(isSafeWebhookUrl('https://gitea.example.com/o/r/raw/branch/main/compose.yml').ok).toBe(true);
	});
});
