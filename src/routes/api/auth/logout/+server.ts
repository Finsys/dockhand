import { json } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { destroySession, getOidcLogoutRedirect, getSessionOidcProvider } from '$lib/server/auth';
import { authorize } from '$lib/server/authorize';
import { auditAuth } from '$lib/server/audit';
import { getClientIp } from '$lib/server/client-ip';

/**
 * @openapi
 * summary: Destroy the current session (clears the dockhand_session cookie)
 * description: When the session came from an OIDC provider that publishes an end-session endpoint, the response carries a logoutUrl the caller should navigate to so the provider ends its own session too. Never present when the instance sets OIDC_END_SESSION=false.
 * resp-200: {success:boolean!, logoutUrl:string}
 * resp-200-example: {"success":true}
 * resp-500: Unexpected error while destroying the session
 */
export const POST: RequestHandler = async (event) => {
	const { cookies, url } = event;
	try {
		// Get current user before destroying session for audit log
		const auth = await authorize(cookies);
		const username = auth.user?.username || 'unknown';
		const clientIp = getClientIp(event);

		// Which provider issued this session, read while the session row still exists.
		// Signing out of Dockhand alone leaves the provider's session open, so the
		// next sign-in walks straight back in without being asked (#562, #1318).
		const providerName = await getSessionOidcProvider(cookies);

		// Signed out here FIRST, before anything reaches for the network: a provider
		// that hangs or errors must never be able to leave somebody logged in.
		await destroySession(cookies);

		// Back to the form, not to auto-login: a page that sends somebody who just
		// signed out straight to a provider with a live session signs them back in.
		const logoutUrl = await getOidcLogoutRedirect(providerName, `${url.origin}/login?local=1`);
		console.log(`[Auth] Logout: user=${username} ip=${clientIp}`);

		// Audit log
		await auditAuth(event, 'logout', username);

		return json(logoutUrl ? { success: true, logoutUrl } : { success: true });
	} catch (error) {
		console.error('Logout error:', error);
		return json({ error: 'Logout failed' }, { status: 500 });
	}
};
