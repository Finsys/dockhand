import { json } from '@sveltejs/kit';
import { authorize, enterpriseRequired } from '$lib/server/authorize';
import { getAuditLogs, getAuditLogUsers, type AuditLogFilters, type AuditEntityType, type AuditAction } from '$lib/server/db';
import type { RequestHandler } from './$types';

/**
 * @openapi
 * summary: Query the audit log with filters and pagination (Enterprise only)
 * query: usernames:string Comma-separated usernames to filter by
 * query: entityTypes:string Comma-separated entity types to filter by
 * query: actions:string Comma-separated actions to filter by
 * query: username:string Legacy single-username filter
 * query: entityType:string Legacy single entity-type filter
 * query: action:string Legacy single-action filter
 * query: environmentId:integer Filter to a single environment (from GET /api/environments)
 * query: labels:string Comma-separated labels to filter by
 * query: fromDate:string Start of the date range (ISO 8601)
 * query: toDate:string End of the date range (ISO 8601)
 * query: limit:integer Maximum number of entries to return
 * query: offset:integer Number of entries to skip (pagination)
 * resp-200: {logs:array<{id:integer!, username:string, action:string, entityType:string, entityName:string, createdAt:string}>, total:integer}
 * resp-403: Enterprise required, or permission denied
 * resp-500: Failed to fetch audit logs
 */
export const GET: RequestHandler = async ({ url, cookies }) => {
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
		// Parse query parameters
		const filters: AuditLogFilters = {};

		// Support multi-select filters (comma-separated)
		const usernames = url.searchParams.get('usernames');
		if (usernames) filters.usernames = usernames.split(',').filter(Boolean);

		const entityTypes = url.searchParams.get('entityTypes');
		if (entityTypes) filters.entityTypes = entityTypes.split(',').filter(Boolean) as AuditEntityType[];

		const actions = url.searchParams.get('actions');
		if (actions) filters.actions = actions.split(',').filter(Boolean) as AuditAction[];

		// Legacy single-value support
		const username = url.searchParams.get('username');
		if (username) filters.usernames = [username];

		const entityType = url.searchParams.get('entityType');
		if (entityType) filters.entityTypes = [entityType as AuditEntityType];

		const action = url.searchParams.get('action');
		if (action) filters.actions = [action as AuditAction];

		const envId = url.searchParams.get('environmentId');
		if (envId) filters.environmentId = parseInt(envId);

		// Labels filter (comma-separated)
		const labels = url.searchParams.get('labels');
		if (labels) filters.labels = labels.split(',').filter(Boolean);

		const fromDate = url.searchParams.get('fromDate');
		if (fromDate) filters.fromDate = fromDate;

		const toDate = url.searchParams.get('toDate');
		if (toDate) filters.toDate = toDate;

		const limit = url.searchParams.get('limit');
		if (limit) filters.limit = parseInt(limit);

		const offset = url.searchParams.get('offset');
		if (offset) filters.offset = parseInt(offset);

		const result = await getAuditLogs(filters);
		return json(result);
	} catch (error) {
		console.error('Error fetching audit logs:', error);
		return json({ error: 'Failed to fetch audit logs' }, { status: 500 });
	}
};
