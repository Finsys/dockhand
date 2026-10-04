import { secureRandomBytes } from './crypto-fallback';

export const WEBAUTHN_RP_NAME = 'Dockhand';
export const WEBAUTHN_CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const WEBAUTHN_MAX_PENDING_CHALLENGES = 1000;

export type WebAuthnCeremony = 'registration' | 'authentication';

export interface WebAuthnChallenge {
	id: string;
	challenge: string;
	ceremony: WebAuthnCeremony;
	expiresAt: number;
	userId?: number;
	sessionId?: string;
	userHandle?: string;
	passkeyName?: string;
}

export class WebAuthnChallengeStore {
	private readonly challenges = new Map<string, WebAuthnChallenge>();

	constructor(
		private readonly now: () => number = Date.now,
		private readonly ttlMs = WEBAUTHN_CHALLENGE_TTL_MS,
		private readonly maxPending = WEBAUTHN_MAX_PENDING_CHALLENGES
	) {}

	issue(
		challenge: string,
		ceremony: WebAuthnCeremony,
		binding: Pick<WebAuthnChallenge, 'userId' | 'sessionId' | 'userHandle' | 'passkeyName'> = {}
	): WebAuthnChallenge {
		this.removeExpired();
		if (this.challenges.size >= this.maxPending) {
			throw new Error('Too many pending WebAuthn ceremonies');
		}

		const entry: WebAuthnChallenge = {
			id: secureRandomBytes(32).toString('base64url'),
			challenge,
			ceremony,
			expiresAt: this.now() + this.ttlMs,
			...binding
		};
		this.challenges.set(entry.id, entry);
		return entry;
	}

	consume(
		id: string,
		ceremony: WebAuthnCeremony,
		binding: Pick<WebAuthnChallenge, 'userId' | 'sessionId'> = {}
	): WebAuthnChallenge | null {
		const entry = this.challenges.get(id);
		if (!entry) return null;

		// Consume before validating anything. Every failure requires a new ceremony.
		this.challenges.delete(id);
		if (entry.expiresAt <= this.now() || entry.ceremony !== ceremony) return null;
		if (binding.userId !== undefined && entry.userId !== binding.userId) return null;
		if (binding.sessionId !== undefined && entry.sessionId !== binding.sessionId) return null;
		return entry;
	}

	private removeExpired(): void {
		const now = this.now();
		for (const [id, entry] of this.challenges) {
			if (entry.expiresAt <= now) this.challenges.delete(id);
		}
	}

	/** Test-only visibility without exposing challenge contents. */
	get size(): number {
		this.removeExpired();
		return this.challenges.size;
	}
}

export const webAuthnChallenges = new WebAuthnChallengeStore();

export interface WebAuthnConfig {
	expectedOrigin: string;
	rpId: string;
}

export function getWebAuthnConfig(): WebAuthnConfig {
	const configuredOrigin = process.env.ORIGIN;
	const origin = configuredOrigin || (process.env.NODE_ENV !== 'production' ? 'http://localhost:5173' : '');
	if (!origin) {
		throw new Error('ORIGIN must be configured to enable Passkeys');
	}

	let url: URL;
	try {
		url = new URL(origin);
	} catch {
		throw new Error('ORIGIN must be a valid absolute URL to enable Passkeys');
	}

	if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
		throw new Error('ORIGIN must contain only scheme, host, and optional port');
	}

	const isLocalhost = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
	if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocalhost)) {
		throw new Error('Passkeys require an HTTPS ORIGIN (HTTP is allowed only for localhost)');
	}

	return { expectedOrigin: url.origin, rpId: url.hostname };
}

export function hasExactWebAuthnOrigin(request: Request): boolean {
	return request.headers.get('origin') === getWebAuthnConfig().expectedOrigin;
}

export function encodeWebAuthnBytes(value: Uint8Array): string {
	return Buffer.from(value).toString('base64url');
}

export function decodeWebAuthnBytes(value: string): Uint8Array<ArrayBuffer> {
	return Uint8Array.from(Buffer.from(value, 'base64url'));
}

export function newWebAuthnUserHandle(): string {
	return secureRandomBytes(32).toString('base64url');
}
