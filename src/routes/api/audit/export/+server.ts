import { authorize, enterpriseRequired } from '$lib/server/authorize';
import { getAuditLogs, type AuditLogFilters, type AuditEntityType, type AuditAction, type AuditLog } from '$lib/server/db';
import { rowsToCSV } from '$lib/server/csv';
import type { RequestHandler } from './$types';

function formatToJSON(logs: AuditLog[]): string {
	return JSON.stringify(logs, null, 2);
}

function formatToCSV(logs: AuditLog[]): string {
	const headers = [
		'ID',
		'Timestamp',
		'Username',
		'Action',
		'Entity Type',
		'Entity ID',
		'Entity Name',
		'Environment ID',
		'Description',
		'IP Address',
		'User Agent',
		'Details'
	];

	const rows = logs.map((log) => [
		log.id,
		log.createdAt,
		log.username,
		log.action,
		log.entityType,
		log.entityId,
		log.entityName,
		log.environmentId ?? '',
		log.description,
		log.ipAddress,
		log.userAgent,
		log.details ? JSON.stringify(log.details) : ''
	]);

	return rowsToCSV(headers, rows);
}

function formatToMarkdown(logs: AuditLog[]): string {
	const lines: string[] = [];

	lines.push('# Audit Log Export');
	lines.push('');
	lines.push(`Generated: ${new Date().toISOString()}`);
	lines.push('');
	lines.push(`Total entries: ${logs.length}`);
	lines.push('');
	lines.push('---');
	lines.push('');

	for (const log of logs) {
		lines.push(`## ${log.action.toUpperCase()} - ${log.entityType}`);
		lines.push('');
		lines.push(`| Field | Value |`);
		lines.push(`|-------|-------|`);
		lines.push(`| Timestamp | ${log.createdAt} |`);
		lines.push(`| User | ${log.username} |`);
		lines.push(`| Action | ${log.action} |`);
		lines.push(`| Entity Type | ${log.entityType} |`);
		if (log.entityName) lines.push(`| Entity Name | ${log.entityName} |`);
		if (log.entityId) lines.push(`| Entity ID | \`${log.entityId}\` |`);
		if (log.environmentId) lines.push(`| Environment ID | ${log.environmentId} |`);
		if (log.description) lines.push(`| Description | ${log.description} |`);
		if (log.ipAddress) lines.push(`| IP Address | ${log.ipAddress} |`);

		if (log.details) {
			lines.push('');
			lines.push('**Details:**');
			lines.push('```json');
			lines.push(JSON.stringify(log.details, null, 2));
			lines.push('```');
		}

		lines.push('');
		lines.push('---');
		lines.push('');
	}

	return lines.join('\n');
}

/**
 * @openapi
 * summary: Export the audit log as a downloadable file in JSON, CSV or Markdown (Enterprise only)
 * query: username:string Filter by username
 * query: entityType:string Filter by entity type
 * query: action:string Filter by action
 * query: environmentId:integer Filter to a single environment (from GET /api/environments)
 * query: fromDate:string Start of the date range (ISO 8601)
 * query: toDate:string End of the date range (ISO 8601)
 * query: format:string Output format — json (default), csv or md
 * resp-200: Downloadable audit-log export (Content-Disposition attachment; JSON, CSV or Markdown)
 * resp-403: Enterprise required, or permission denied
 * resp-500: Failed to export audit logs
 */
export const GET: RequestHandler = async ({ url, cookies }) => {
	const auth = await authorize(cookies);

	// Audit log is Enterprise-only
	if (!auth.isEnterprise) {
		return new Response(JSON.stringify(enterpriseRequired()), {
			status: 403,
			headers: { 'Content-Type': 'application/json' }
		});
	}

	// Check permission
	if (!await auth.canViewAuditLog()) {
		return new Response(JSON.stringify({ error: 'Permission denied' }), {
			status: 403,
			headers: { 'Content-Type': 'application/json' }
		});
	}

	try {
		// Parse query parameters
		const filters: AuditLogFilters = {};

		const username = url.searchParams.get('username');
		if (username) filters.username = username;

		const entityType = url.searchParams.get('entityType');
		if (entityType) filters.entityType = entityType as AuditEntityType;

		const action = url.searchParams.get('action');
		if (action) filters.action = action as AuditAction;

		const envId = url.searchParams.get('environmentId');
		if (envId) filters.environmentId = parseInt(envId);

		const fromDate = url.searchParams.get('fromDate');
		if (fromDate) filters.fromDate = fromDate;

		const toDate = url.searchParams.get('toDate');
		if (toDate) filters.toDate = toDate;

		// For export, get all matching records (no pagination)
		filters.limit = 10000; // Reasonable max limit

		const result = await getAuditLogs(filters);
		const logs = result.logs;

		const format = url.searchParams.get('format') || 'json';
		const timestamp = new Date().toISOString().split('T')[0];

		let content: string;
		let contentType: string;
		let filename: string;

		switch (format) {
			case 'csv':
				content = formatToCSV(logs);
				contentType = 'text/csv';
				filename = `audit-log-${timestamp}.csv`;
				break;
			case 'md':
				content = formatToMarkdown(logs);
				contentType = 'text/markdown';
				filename = `audit-log-${timestamp}.md`;
				break;
			case 'json':
			default:
				content = formatToJSON(logs);
				contentType = 'application/json';
				filename = `audit-log-${timestamp}.json`;
				break;
		}

		return new Response(content, {
			status: 200,
			headers: {
				'Content-Type': contentType,
				'Content-Disposition': `attachment; filename="${filename}"`
			}
		});
	} catch (error) {
		console.error('Error exporting audit logs:', error);
		return new Response(JSON.stringify({ error: 'Failed to export audit logs' }), {
			status: 500,
			headers: { 'Content-Type': 'application/json' }
		});
	}
};
