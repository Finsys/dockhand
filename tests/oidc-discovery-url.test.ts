import { describe, it, expect } from 'bun:test';
import { oidcDiscoveryUrls, fetchOidcDiscovery } from '../src/lib/utils/oidc-discovery-url';

const ok = (statusText = 'OK') => ({ ok: true, statusText });
const notOk = (statusText: string) => ({ ok: false, statusText });

describe('oidcDiscoveryUrls', () => {
	it('tries the canonical (no trailing slash) URL first, then the trailing-slash variant', () => {
		expect(oidcDiscoveryUrls('https://idp.example.com/realm')).toEqual([
			'https://idp.example.com/realm/.well-known/openid-configuration',
			'https://idp.example.com/realm/.well-known/openid-configuration/'
		]);
	});

	it('normalises an issuer that already ends with a slash (no double slash)', () => {
		expect(oidcDiscoveryUrls('https://idp.example.com/realm/')).toEqual([
			'https://idp.example.com/realm/.well-known/openid-configuration',
			'https://idp.example.com/realm/.well-known/openid-configuration/'
		]);
	});

	it('handles a bare-host issuer', () => {
		expect(oidcDiscoveryUrls('https://idp.example.com')).toEqual([
			'https://idp.example.com/.well-known/openid-configuration',
			'https://idp.example.com/.well-known/openid-configuration/'
		]);
	});
});

describe('fetchOidcDiscovery', () => {
	it('returns the FIRST url on OK - a compliant provider never sees the fallback', async () => {
		const tried: string[] = [];
		const r = await fetchOidcDiscovery(['a', 'b'], async (u) => { tried.push(u); return ok(); });
		expect(tried).toEqual(['a']);
		expect(r.ok).toBe(true);
	});

	it('falls back to the trailing-slash url when the canonical one is 404 (#1368)', async () => {
		const tried: string[] = [];
		const r = await fetchOidcDiscovery(['canon', 'canon/'], async (u) => {
			tried.push(u);
			return u.endsWith('/') ? ok() : notOk('Not Found');
		});
		expect(tried).toEqual(['canon', 'canon/']);
		expect(r.ok).toBe(true);
	});

	it('throws with the last statusText when every url is not-ok', async () => {
		await expect(fetchOidcDiscovery(['a', 'b'], async () => notOk('Not Found')))
			.rejects.toThrow('Failed to fetch OIDC discovery document: Not Found');
	});

	it('a network error is fatal - does NOT fall through to the next url', async () => {
		const tried: string[] = [];
		const boom = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
		await expect(fetchOidcDiscovery(['a', 'b'], async (u) => { tried.push(u); throw boom; }))
			.rejects.toThrow('Failed to reach OIDC issuer at a: fetch failed (ENOTFOUND)');
		expect(tried).toEqual(['a']); // stopped at the first, did not try 'b'
	});
});
