import { json } from '@sveltejs/kit';
import { authorize, enterpriseRequired } from '$lib/server/authorize';
import { getAuditLogs, getAuditLogUsers, type AuditLogFilters, type AuditEntityType, type AuditAction } from '$lib/server/db';
import type { RequestHandler } from './$types';

/**
 * @openapi
 * summary: List audit log entries with optional filters (Enterprise only)
 * query: username:string
 * query: entity_type:string
 * query: action:string
 * query: environment_id:integer
 * query: from_date:string
 * query: to_date:string
 * query: limit:integer
 * query: offset:integer
 * resp-200: {logs:array<{id:integer!, userId:integer, username:string!, action:string!, entityType:string!, entityId:string, entityName:string, environmentId:integer, description:string, details:{}, ipAddress:string, userAgent:string, createdAt:string!}>!, total:integer!, limit:integer!, offset:integer!}
 * resp-403: Enterprise license required, or permission denied to view the audit log
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

		const username = url.searchParams.get('username');
		if (username) filters.username = username;

		const entityType = url.searchParams.get('entity_type');
		if (entityType) filters.entityType = entityType as AuditEntityType;

		const action = url.searchParams.get('action');
		if (action) filters.action = action as AuditAction;

		const envId = url.searchParams.get('environment_id');
		if (envId) filters.environmentId = parseInt(envId);

		const fromDate = url.searchParams.get('from_date');
		if (fromDate) filters.fromDate = fromDate;

		const toDate = url.searchParams.get('to_date');
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
