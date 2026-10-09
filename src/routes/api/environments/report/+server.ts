import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { getEnvironments } from '$lib/server/db';
import { collectEnvironment } from '$lib/server/environment-report';
import {
	buildReport,
	includeChanges,
	reportFilename,
	reportToCSV,
	reportTier
} from '$lib/server/environment-report-core';

/**
 * @openapi
 * summary: Export an environment state report as a downloadable file
 * description: Inventory, vulnerability counts and scan coverage for one environment or for every environment the caller may see. Requires a valid paid license of either tier. The change history is included only for an enterprise license, because it is the audit log under another name.
 * query: env:integer One environment id; omit to report on every accessible environment
 * query: format:string Output format - json (default), csv, or pdf
 * resp-200: The report as a downloadable json, csv or pdf attachment
 * resp-400: The env query parameter is not a number
 * resp-401: Authentication required
 * resp-403: A paid license is required, or permission denied
 * resp-404: No accessible environment matches the requested id
 * resp-500: Failed to build the report
 */
export const GET: RequestHandler = async ({ url, cookies }) => {
	const auth = await authorize(cookies);

	if (auth.authEnabled && !auth.isAuthenticated) {
		return json({ error: 'Authentication required' }, { status: 401 });
	}

	const tier = reportTier(auth.licenseTier);
	if (!tier) {
		return json({ error: 'A commercial license is required' }, { status: 403 });
	}

	if (!(await auth.can('environments', 'view'))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const envParam = url.searchParams.get('env');
		const all = await getEnvironments();
		const accessible = await auth.getAccessibleEnvironmentIds();

		let selected = accessible === null ? all : all.filter((e) => accessible.includes(e.id));

		if (envParam !== null && envParam !== '') {
			const wanted = parseInt(envParam, 10);
			if (!Number.isFinite(wanted)) {
				return json({ error: 'Invalid environment id' }, { status: 400 });
			}
			selected = selected.filter((e) => e.id === wanted);
			if (selected.length === 0) {
				return json({ error: 'Environment not found' }, { status: 404 });
			}
		}

		// The change history is the audit log, so it answers to the audit permission
		// as well as the tier. A caller without it still gets the report, minus that
		// section, rather than being refused the export outright.
		const withChanges = includeChanges(tier) && (await auth.canViewAuditLog());
		const environments = await Promise.all(
			selected.map((e) => collectEnvironment(e.id, e.name, withChanges))
		);

		const generatedAt = new Date().toISOString();
		const report = buildReport(environments, withChanges, {
			generatedAt,
			appVersion: __APP_VERSION__ ?? 'unknown'
		});

		const format = (url.searchParams.get('format') || 'json').toLowerCase();
		const scope = selected.length === 1 ? selected[0].name : 'all-environments';

		if (format === 'pdf') {
			// Imported here, not at module scope, so pdfkit stays out of the startup heap.
			const { buildReportPdf, reportPdfFilename, readReportLogo } = await import(
				'$lib/server/environment-report-pdf'
			);
			const pdf = await buildReportPdf(report, await readReportLogo());
			return new Response(new Uint8Array(pdf), {
				headers: {
					'Content-Type': 'application/pdf',
					'Content-Disposition': `attachment; filename="${reportPdfFilename(report, selected.length === 1 ? selected[0].name : null)}"`
				}
			});
		}

		const filename = reportFilename(scope, generatedAt, format === 'csv' ? 'csv' : 'json');
		const body = format === 'csv' ? reportToCSV(report) : JSON.stringify(report, null, 2);

		return new Response(body, {
			headers: {
				'Content-Type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json',
				'Content-Disposition': `attachment; filename="${filename}"`
			}
		});
	} catch (error) {
		console.error('Error building environment report:', error);
		return json({ error: 'Failed to build the report' }, { status: 500 });
	}
};
