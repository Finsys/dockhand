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
