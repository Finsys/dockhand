import { json, type RequestHandler } from '@sveltejs/kit';
import { getSetting, setSetting } from '$lib/server/db';
import { evaluateExposure } from '$lib/server/exposure-warning';
import { isAuthEnabled } from '$lib/server/auth';

const DISMISS_KEY = 'security_exposure_dismissed';

/**
 * @openapi
 * summary: Whether this instance is listening beyond localhost with auth off and the Docker socket writable, and whether that warning was dismissed
 * description: Public so the warning can render while authentication is disabled. Returns {warn, dismissed}; warn is true only when auth is off, the bind host is not loopback, and the Docker socket is mounted read-write.
 * resp-200: object
 * resp-200-desc: { warn: boolean, dismissed: boolean }
 */
export const GET: RequestHandler = async () => {
	const host = process.env.HOST || '0.0.0.0';
	const [warn, dismissedRaw] = await Promise.all([
		evaluateExposure(host),
		getSetting(DISMISS_KEY)
	]);
	return json({ warn, dismissed: dismissedRaw === 'true' });
};

/**
 * @openapi
 * summary: Dismiss the unsecured-exposure warning for this instance
 * description: Reachable without a session only while authentication is disabled (the warning's only state); once auth is on it returns 403, so a secured instance exposes no public write. Stores a per-instance flag so the warning does not show again.
 * resp-200: object
 * resp-200-desc: { dismissed: true }
 * resp-403: Authentication is enabled; the warning never fires, so there is nothing to dismiss
 */
export const POST: RequestHandler = async () => {
	// The warning only shows while auth is off, so the dismiss only needs to work then.
	// Gating it here means a secured instance has no unauthenticated write at all.
	if (await isAuthEnabled()) {
		return json({ error: 'Not applicable when authentication is enabled' }, { status: 403 });
	}
	await setSetting(DISMISS_KEY, 'true');
	return json({ dismissed: true });
};
