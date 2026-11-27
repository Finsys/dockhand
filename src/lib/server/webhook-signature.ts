import crypto from 'node:crypto';

/**
 * Constant-time string equality. Returns false on a length mismatch (lengths leak anyway)
 * and otherwise compares in time independent of where the first difference is, so a secret
 * compared against an attacker-supplied value does not leak via timing.
 */
export function timingSafeStringEqual(a: string, b: string): boolean {
	const aBuf = Buffer.from(a);
	const bBuf = Buffer.from(b);
	if (aBuf.length !== bBuf.length) return false;
	return crypto.timingSafeEqual(aBuf, bBuf);
}

/**
 * Verify a git webhook signature against the configured secret.
 *
 * Two provider families share these two wire formats:
 * - GitHub / Gitea / Forgejo send `X-Hub-Signature-256: sha256=<hmac>` where the
 *   hmac is HMAC-SHA256 of the raw request body keyed by the secret.
 * - GitLab sends `X-Gitlab-Token: <secret>` as a plain token compared for equality.
 *
 * The caller passes whichever header value is present as `signature`.
 */
export function verifyWebhookSignature(payload: string, signature: string | null, secret: string): boolean {
	if (!signature) return false;

	if (signature.startsWith('sha256=')) {
		const expectedSignature = 'sha256=' + crypto
			.createHmac('sha256', secret)
			.update(payload)
			.digest('hex');
		const sigBuf = Buffer.from(signature);
		const expectedBuf = Buffer.from(expectedSignature);
		if (sigBuf.length !== expectedBuf.length) return false;
		return crypto.timingSafeEqual(sigBuf, expectedBuf);
	}

	// GitLab token: exact match, constant-time.
	return timingSafeStringEqual(signature, secret);
}
