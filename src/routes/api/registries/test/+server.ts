import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { parseRegistryUrl, getRegistryAuthHeader, DOCKER_HUB_HOSTS } from '$lib/server/docker';
import { getRegistry } from '$lib/server/db';
import { isSafeNotificationUrl } from '$lib/server/url-safety';

/**
 * Test registry connectivity and credentials.
 *
 * Accepts either inline credentials (from the modal form) or a registry ID
 * (to test an already-saved registry using stored credentials).
 */
/**
 * @openapi
 * summary: Test registry connectivity and (if credentials are given) authentication against the V2 endpoint
 * description: Pass either a saved registryId or inline url/username/password. The outcome is always reported in a 200 body via the success/connectivity/authenticated fields, never as an HTTP error. registryId from GET /api/registries.
 * body: {registryId:integer, url:string, username:string, password:string}
 * body-example: {"url":"https://ghcr.io","username":"deploy","password":"***"}
 * resp-200: {success:boolean!, connectivity:boolean!, authenticated:boolean, message:string!}
 * resp-200-example: {"success":true,"connectivity":true,"authenticated":true,"message":"Connected and authenticated as deploy"}
 * resp-400: The url field is missing (and no registryId was supplied)
 * resp-403: Caller lacks the registries:view permission
 * resp-404: The referenced registryId does not exist
 */
export const POST: RequestHandler = async ({ request, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('registries', 'view')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	const data = await request.json();
	let url: string;
	let username: string | undefined;
	let password: string | undefined;

	if (data.registryId) {
		// Test a saved registry — fetch credentials from DB
		const reg = await getRegistry(data.registryId);
		if (!reg) return json({ error: 'Registry not found' }, { status: 404 });
		url = reg.url;
		username = reg.username || undefined;
		password = reg.password || undefined;
	} else {
		url = data.url;
		username = data.username?.trim() || undefined;
		password = data.password?.trim() || undefined;
	}

	if (!url) {
		return json({ error: 'URL is required' }, { status: 400 });
	}

	// SSRF guard on the inline-url path only: a saved registryId is admin-configured,
	// but an inline url is caller-supplied. A registry legitimately lives on a LAN
	// (self-hosted Harbor/registry:5000), so allow private ranges but block loopback
	// + cloud metadata + reserved so this tester can't probe the control plane / IMDS.
	if (!data.registryId) {
		const withScheme = /^https?:\/\//i.test(url) ? url : `https://${url}`;
		const safety = isSafeNotificationUrl(withScheme);
		if (!safety.ok) {
			return json({ success: false, connectivity: false, message: `Registry host not allowed: ${safety.reason}` });
		}
	}

	const parsed = parseRegistryUrl(url);
	const apiBase = `${parsed.protocol}://${parsed.host}`;

	try {
		// Step 1: connectivity — can we reach /v2/ at all?
		const pingResp = await fetch(`${apiBase}/v2/`, {
			method: 'GET',
			headers: { 'User-Agent': 'Dockhand/1.0' },
			signal: AbortSignal.timeout(10_000)
		});

		const hasAuth = pingResp.status === 401;
		const isOpen = pingResp.ok;

		if (!isOpen && !hasAuth) {
			return json({
				success: false,
				connectivity: false,
				message: `Registry returned HTTP ${pingResp.status}`
			});
		}

		// Step 2: if credentials provided, test authentication.
		// Empty scope — we only care whether the registry accepts the login.
		// Asking for a privileged scope like registry:catalog:* causes Docker
		// Hub to reject the request with HTTP 400 for non-admin users even
		// when their credentials are valid.
		if (username && password) {
			const authHeader = await getRegistryAuthHeader(url, '', { username, password });

			if (!authHeader) {
				return json({
					success: false,
					connectivity: true,
					authenticated: false,
					message: 'Authentication failed — check username and password'
				});
			}

			// Verify the token works
			const authResp = await fetch(`${apiBase}/v2/`, {
				method: 'GET',
				headers: {
					'User-Agent': 'Dockhand/1.0',
					'Authorization': authHeader
				},
				signal: AbortSignal.timeout(10_000)
			});

			if (!authResp.ok) {
				return json({
					success: false,
					connectivity: true,
					authenticated: false,
					message: `Authentication token rejected (HTTP ${authResp.status})`
				});
			}

			const isHub = DOCKER_HUB_HOSTS.has(parsed.host);
			return json({
				success: true,
				connectivity: true,
				authenticated: true,
				message: isHub
					? `Connected to Docker Hub as ${username}`
					: `Connected and authenticated as ${username}`
			});
		}

		// No credentials — just report connectivity
		const isHub = DOCKER_HUB_HOSTS.has(parsed.host);
		return json({
			success: true,
			connectivity: true,
			authenticated: null,
			message: isHub
				? 'Docker Hub is reachable (no credentials to test)'
				: isOpen
					? 'Registry is reachable (no auth required)'
					: 'Registry is reachable (requires authentication)'
		});
	} catch (e: any) {
		const msg = e?.cause?.code || e?.message || String(e);
		return json({
			success: false,
			connectivity: false,
			message: `Connection failed: ${msg}`
		});
	}
};
