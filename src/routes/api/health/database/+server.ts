/**
 * Database Health Check Endpoint
 *
 * Public endpoint suitable for external monitoring. The public payload reports
 * enough detail to detect schema drift and table loss without exposing
 * connection details (host, port, db name, user) or the running migration tag.
 *
 * Authenticated callers with settings:view get the full payload — connection
 * string (password masked) and schema version included — which is useful for
 * operators debugging from the admin UI.
 *
 * GET /api/health/database
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { checkSchemaHealth } from '$lib/server/db/drizzle';
import { authorize } from '$lib/server/authorize';

/**
 * GET /api/health/database - Database schema health check
 *
 * @openapi
 * summary: Public database health check reporting schema/migration/table status; authenticated settings:view callers also get connection details
 * description: Returns HTTP 200 when healthy and 503 when unhealthy (schema drift or table loss); 500 on an unexpected error. Connection details and the migration tag are only included for authenticated callers with settings:view.
 * resp-200: {healthy:boolean!, database:string!, migrationsTable:boolean!, appliedMigrations:integer!, pendingMigrations:integer!, tables:integer!, timestamp:string!}
 * resp-200-desc: Schema health; an unhealthy database returns the same shape with HTTP 503
 * resp-200-example: {"healthy":true,"database":"sqlite","migrationsTable":true,"appliedMigrations":42,"pendingMigrations":0,"tables":25,"timestamp":"2026-07-01T10:00:00.000Z"}
 * resp-500: Unexpected error while checking database health
 * resp-500-example: {"healthy":false,"error":"connection refused","timestamp":"2026-07-01T10:00:00.000Z"}
 */
export const GET: RequestHandler = async ({ cookies }) => {
	try {
		const health = await checkSchemaHealth();

		const auth = await authorize(cookies);
		const showFullDetail = !auth.authEnabled
			|| (auth.isAuthenticated && await auth.can('settings', 'view'));

		const payload = showFullDetail
			? health
			: {
				healthy: health.healthy,
				database: health.database,
				migrationsTable: health.migrationsTable,
				appliedMigrations: health.appliedMigrations,
				pendingMigrations: health.pendingMigrations,
				tables: health.tables,
				timestamp: health.timestamp
			};

		return json(payload, {
			status: health.healthy ? 200 : 503,
			headers: {
				'Cache-Control': 'no-cache, no-store, must-revalidate'
			}
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';

		return json(
			{
				healthy: false,
				error: message,
				timestamp: new Date().toISOString()
			},
			{
				status: 500,
				headers: {
					'Cache-Control': 'no-cache, no-store, must-revalidate'
				}
			}
		);
	}
};
