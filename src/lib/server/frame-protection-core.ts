/**
 * Framing protection is ON by default: Dockhand sends `X-Frame-Options: DENY` and
 * `Content-Security-Policy: frame-ancestors 'none'` so no page can embed the UI in a
 * frame (anti-clickjacking). An operator who wants to embed Dockhand in a trusted parent
 * page - e.g. a Home Assistant or homelab dashboard iframe - opts out with the
 * DISABLE_FRAME_PROTECTION env var; that drops both framing headers (nosniff is
 * unaffected). Pure so the toggle is unit-tested and shared by the hook and server.js.
 */

/** Whether to send framing headers. False only when DISABLE_FRAME_PROTECTION is truthy. */
export function frameProtectionEnabled(raw: string | null | undefined): boolean {
	return !(raw === 'true' || raw === '1');
}
