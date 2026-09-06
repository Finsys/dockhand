export const WEBHOOK_SECRET_REQUIRED_ERROR =
	'A webhook secret is required when the webhook is enabled';

export function generateWebhookSecret(byteLength = 32): string {
	const array = new Uint8Array(byteLength);
	crypto.getRandomValues(array);
	return Array.from(array, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function webhookSecretValidationError(
	enabled: boolean,
	secret: string | null | undefined
): string | undefined {
	if (enabled && !secret?.trim()) {
		return WEBHOOK_SECRET_REQUIRED_ERROR;
	}
	return undefined;
}

export function ensureWebhookSecret(enabled: boolean, current: string): string {
	if (enabled && !current.trim()) {
		return generateWebhookSecret();
	}
	return current;
}
