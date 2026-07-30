import { json } from '@sveltejs/kit';
import { authorize, enterpriseRequired } from '$lib/server/authorize';
import { getAuditLogUsers } from '$lib/server/db';
import type { RequestHandler } from './$types';

/**
 * @openapi
 * summary: List the distinct usernames that appear in the audit log, for filter dropdowns (Enterprise only)
 * resp-200: array<string>
 * resp-200-example: ["admin","ci-bot","alice"]
 * resp-403: Enterprise required, or permission denied
 * resp-500: Failed to fetch audit log users
 */
export const GET: RequestHandler = async ({ cookies }) => {
	const auth = await authorize(cookies);

	// Audit log is Enterprise-only
	if (!auth.isEnterprise) {
		return json(enterpriseRequired(), { status: 403 });
	}

	// Check permission
	if (!await auth.canViewAuditLog()) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const users = await getAuditLogUsers();
		return json(users);
	} catch (error) {
		console.error('Error fetching audit log users:', error);
		return json({ error: 'Failed to fetch audit log users' }, { status: 500 });
	}
};
