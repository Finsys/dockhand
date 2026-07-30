import { json } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { destroySession } from '$lib/server/auth';
import { authorize } from '$lib/server/authorize';
import { auditAuth } from '$lib/server/audit';
import { getClientIp } from '$lib/server/client-ip';

/**
 * @openapi
 * summary: Destroy the current session (clears the dockhand_session cookie)
 * resp-200: {success:boolean!}
 * resp-200-example: {"success":true}
 * resp-500: Unexpected error while destroying the session
 */
export const POST: RequestHandler = async (event) => {
	const { cookies } = event;
	try {
		// Get current user before destroying session for audit log
		const auth = await authorize(cookies);
		const username = auth.user?.username || 'unknown';
		const clientIp = getClientIp(event);

		await destroySession(cookies);
		console.log(`[Auth] Logout: user=${username} ip=${clientIp}`);

		// Audit log
		await auditAuth(event, 'logout', username);

		return json({ success: true });
	} catch (error) {
		console.error('Logout error:', error);
		return json({ error: 'Logout failed' }, { status: 500 });
	}
};
