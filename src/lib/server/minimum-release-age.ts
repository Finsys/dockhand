import { createHash } from 'node:crypto';
import { db, settings } from './db/drizzle';
import { eq } from 'drizzle-orm';
import { deleteSetting, getSetting, setEnvSetting, setSetting } from './db';
import { releaseAgeRemainingMs, resolveMinimumReleaseAgeConfig, validImageCreatedAt, type MinimumReleaseAgeConfig, type ReleaseAgeObservation } from './minimum-release-age-core';
import { parseImageReference } from './registry/image-ref';

const SETTING_KEY = 'minimum_release_age_hours';

/** Resolve the effective age for an environment, including any configured override. */
export async function getMinimumReleaseAgeConfig(envId?: number | null): Promise<MinimumReleaseAgeConfig> {
	const [globalSetting, environmentSetting] = await Promise.all([
		getSetting(SETTING_KEY),
		envId != null ? getSetting(`env_${envId}_${SETTING_KEY}`) : Promise.resolve(null)
	]);
	return resolveMinimumReleaseAgeConfig(process.env.MINIMUM_RELEASE_AGE_HOURS, globalSetting, environmentSetting);
}

export async function setMinimumReleaseAgeHours(hours: number, envId?: number | null): Promise<void> {
	if (envId != null) await setEnvSetting(SETTING_KEY, hours, envId);
	else await setSetting(SETTING_KEY, hours);
}

export async function clearMinimumReleaseAgeHours(envId: number): Promise<void> {
	await deleteSetting(`env_${envId}_${SETTING_KEY}`);
}

/** Always record first observation before metadata lookup. Missing/invalid creation
 * metadata falls back to this durable timestamp, without restarting the timer. */
export async function imageReleaseAgeStatus(
	imageName: string, digest: string, hours: number,
	loadCreatedAt?: () => Promise<string | null>
): Promise<ReleaseAgeObservation> {
	const { registry, repo } = parseImageReference(imageName);
	const key = 'release_age_seen_' + createHash('sha256').update(`${registry}/${repo}@${digest}`).digest('hex');
	const now = new Date().toISOString();
	await db.insert(settings).values({ key, value: JSON.stringify(now) }).onConflictDoNothing();
	const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, key));
	if (!row) throw new Error('Could not record when the image was first seen');
	const firstObservedAt = JSON.parse(row.value) as string;
	let createdAt: string | null = null;
	if (hours > 0 && loadCreatedAt) {
		try { createdAt = validImageCreatedAt(await loadCreatedAt()); } catch { /* use first observation */ }
	}
	const observedAt = createdAt ?? firstObservedAt;
	return { remainingMs: releaseAgeRemainingMs(observedAt, hours), observedAt, source: createdAt ? 'created' : 'first-observed' };
}

export async function imageReleaseAgeRemainingMs(
	imageName: string, digest: string, hours: number,
	loadCreatedAt?: () => Promise<string | null>
): Promise<number> {
	if (hours === 0) return 0;
	return (await imageReleaseAgeStatus(imageName, digest, hours, loadCreatedAt)).remainingMs;
}
