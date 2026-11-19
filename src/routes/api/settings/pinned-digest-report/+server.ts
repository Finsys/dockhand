import { json, type RequestHandler } from '@sveltejs/kit';
import { getPinnedDigestReportEnabled, setPinnedDigestReportEnabled } from '$lib/server/db';
import { authorize } from '$lib/server/authorize';

/**
 * @openapi
 * summary: Get whether a moved digest on a pinned image is reported (#1780)
 * resp-200: {enabled:boolean!}
 * resp-200-example: {"enabled":true}
 * resp-403: Permission denied (needs settings:view)
 */
export const GET: RequestHandler = async ({ cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('settings', 'view')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}
	return json({ enabled: await getPinnedDigestReportEnabled() });
};

/**
 * @openapi
 * summary: Set whether a moved digest on a pinned image is reported (#1780)
 * body: {enabled:boolean!}
 * body-example: {"enabled":false}
 * resp-200: {success:boolean!}
 * resp-403: Permission denied (needs settings:edit)
 */
export const POST: RequestHandler = async ({ request, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('settings', 'edit')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}
	const data = await request.json().catch(() => ({}));
	await setPinnedDigestReportEnabled(data.enabled === true);
	return json({ success: true });
};
