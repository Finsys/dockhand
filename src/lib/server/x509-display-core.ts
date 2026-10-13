/**
 * Display helpers for the certificate metadata logged at HTTPS startup.
 *
 * Node leaves `subject` and `issuer` undefined when the certificate carries an
 * empty distinguished name, which newer Let's Encrypt profiles produce - they
 * identify the host through the SAN alone. Kept in sync with the inline copy in
 * `server.js`, which runs against ./build and cannot import from src.
 */

/** One-line form of an X.509 name, or a placeholder when the cert omits it. */
export function formatCertName(name: string | undefined | null): string {
	if (typeof name !== 'string') return '(none)';
	// Trim FIRST: a name that is only newlines would otherwise collapse to a
	// string of separators rather than reading as absent.
	const trimmed = name.trim();
	return trimmed === '' ? '(none)' : trimmed.replace(/\n/g, ', ');
}

/**
 * Whole-day countdown to expiry. Returns null when the date is unparseable, so
 * the caller can stay quiet rather than reporting a NaN-day warning.
 */
export function daysUntilExpiry(validTo: string | undefined, now: number): number | null {
	if (typeof validTo !== 'string') return null;
	const expiresAt = new Date(validTo).getTime();
	if (Number.isNaN(expiresAt)) return null;
	return Math.floor((expiresAt - now) / 86400000);
}

/** The expiry line to log, and whether it deserves the operator's attention. */
export function expiryLine(daysLeft: number | null): { text: string; warn: boolean } {
	if (daysLeft === null) return { text: 'cert expiry:  (unknown)', warn: false };
	if (daysLeft < 0) {
		return { text: `WARNING: certificate expired ${-daysLeft} day(s) ago`, warn: true };
	}
	if (daysLeft < 30) {
		return { text: `WARNING: certificate expires in ${daysLeft} day(s)`, warn: true };
	}
	return { text: `cert expires in ${daysLeft} day(s)`, warn: false };
}
