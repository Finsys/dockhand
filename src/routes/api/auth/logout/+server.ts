import { json } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { destroySession } from '$lib/server/auth';
import { authorize } from '$lib/server/authorize';
import { auditAuth } from '$lib/server/audit';

// POST /api/auth/logout - End session
export const POST: RequestHandler = async (event) => {
	const { cookies } = event;
	try {
		// Get current user before destroying session for audit log
		const auth = await authorize(cookies);
		const username = auth.user?.username || 'unknown';

		await destroySession(cookies);

		// Audit log
		await auditAuth(event, 'logout', username);

		return json({ success: true });
	} catch (error) {
		console.error('Logout error:', error);
		return json({ error: 'Logout failed' }, { status: 500 });
	}
};
