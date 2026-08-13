import { redirect } from '@sveltejs/kit';
import { landingRedirectTarget } from '$lib/utils/landing';

// SSR is off, so this load runs on the client before the dashboard mounts. Opening `/` redirects
// to the configured landing page here - no dashboard flash, no placeholder. The sidebar's Dashboard
// link carries `?home` to suppress the redirect (see landingRedirectTarget).
export const load = async ({ url, fetch }) => {
	if (url.searchParams.has('home')) return {};
	try {
		const res = await fetch('/api/settings/navigation');
		if (!res.ok) return {};
		const nav = (await res.json())?.effective;
		const target = landingRedirectTarget(nav, false);
		if (target) throw redirect(307, target);
	} catch (e) {
		// Re-throw the redirect; swallow only a failed nav fetch (stay on the dashboard).
		if (e && typeof e === 'object' && 'status' in e && 'location' in e) throw e;
	}
	return {};
};
