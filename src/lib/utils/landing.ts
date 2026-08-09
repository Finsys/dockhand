// Custom-homepage landing decision (pure). SSR is off, so `/`'s client-side load (+page.ts)
// decides whether opening the app should redirect to the user's landing page. Kept pure so the
// redirect rule lives in one testable place.

export interface NavEffective {
	landingPage?: string | null;
	envClickPage?: string | null;
}

/**
 * Where to send the user when opening `/`, or null to stay on the dashboard. Redirects
 * whenever the landing page is a real page other than the dashboard, UNLESS the URL carries the
 * `?home` marker (the sidebar's Dashboard link sets it, so clicking Dashboard is not bounced
 * away). The environment is not forced here - it stays whatever the store already holds.
 */
export function landingRedirectTarget(nav: NavEffective | null | undefined, hasHomeMarker: boolean): string | null {
	if (hasHomeMarker) return null;
	const page = nav?.landingPage;
	if (!page || page === 'dashboard') return null;
	return `/${page}`;
}
