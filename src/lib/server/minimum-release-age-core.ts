/** Docker Hub reports push time; other registries need a first-observed digest fallback. */
export const MAXIMUM_RELEASE_AGE_HOURS = 24 * 30;

/** Pull the digest that passed the age check, then restore the caller's local tag. */
export function verifiedImagePullPlan(imageName: string, digest: string): {
	reference: string;
	tag: { repo: string; tag: string } | null;
} {
	if (!/^sha256:[a-f0-9]{64}$/i.test(digest)) throw new Error('Registry returned an invalid image digest');
	if (imageName.includes('@')) {
		const requestedDigest = imageName.slice(imageName.lastIndexOf('@') + 1);
		if (requestedDigest.toLowerCase() !== digest.toLowerCase()) throw new Error('Registry digest does not match the requested image digest');
		return { reference: imageName, tag: null };
	}

	const colon = imageName.lastIndexOf(':');
	const slash = imageName.lastIndexOf('/');
	const hasTag = colon > slash;
	const repo = hasTag ? imageName.slice(0, colon) : imageName;
	const tag = hasTag ? imageName.slice(colon + 1) : 'latest';
	return { reference: repo + '@' + digest, tag: { repo, tag } };
}

/** Build images have no registry release date; only Compose service-image pulls are gated. */
export function composeReleaseAgeDecision(
	operation: 'up' | 'down' | 'stop' | 'start' | 'restart' | 'pull' | 'build',
	hours: number,
	requestedPullPolicy?: string
): { blockPull: boolean; pullPolicy?: string } {
	return {
		blockPull: hours > 0 && operation === 'pull',
		pullPolicy: hours > 0 && operation === 'up' ? 'never' : requestedPullPolicy
	};
}

/** Hawser first forwarded Compose's --pull policy in v0.2.38. */
export function hawserSupportsPullPolicy(version: string | null | undefined): boolean {
	const match = /^v?(\d+)\.(\d+)\.(\d+)(?:$|[-+])/.exec(version ?? '');
	if (!match) return false;
	const [major, minor, patch] = match.slice(1).map(Number);
	return major > 0 || minor > 2 || (minor === 2 && patch >= 38);
}

/** Explain why Compose cannot start a service when automatic pulls are disabled. */
export function missingImageCooldownError(message: string): string | null {
	const image = /No such image:\s*([^\s]+)/i.exec(message)?.[1];
	if (!image) return null;
	return `Image ${image} is not present in this environment. Minimum image release age prevents Compose from pulling it automatically. Pull this exact image through Dockhand once its cooldown has elapsed, then deploy again.`;
}

export function parseMinimumReleaseAgeHours(value: unknown): number | null {
	const hours = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
	return Number.isInteger(hours) && hours >= 0 && hours <= MAXIMUM_RELEASE_AGE_HOURS ? hours : null;
}

export interface MinimumReleaseAgeConfig {
	hours: number;
	overridden: boolean;
	inherited: boolean;
}

export function resolveMinimumReleaseAgeConfig(
	environmentVariable: string | undefined,
	globalSetting: unknown,
	environmentSetting: unknown = null
): MinimumReleaseAgeConfig {
	if (environmentVariable !== undefined) {
		const hours = parseMinimumReleaseAgeHours(environmentVariable);
		if (hours === null) throw new Error('MINIMUM_RELEASE_AGE_HOURS must be a whole number from 0 to 720');
		return { hours, overridden: true, inherited: true };
	}
	const specific = parseMinimumReleaseAgeHours(environmentSetting);
	if (specific !== null) return { hours: specific, overridden: false, inherited: false };
	return { hours: parseMinimumReleaseAgeHours(globalSetting) ?? 0, overridden: false, inherited: true };
}

export function releaseAgeRemainingMs(firstSeen: string, hours: number, now = Date.now()): number {
	const observed = Date.parse(firstSeen);
	if (!Number.isFinite(observed)) return hours * 60 * 60 * 1000;
	return Math.max(0, observed + hours * 60 * 60 * 1000 - now);
}
