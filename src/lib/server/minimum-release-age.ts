import { createHash } from 'node:crypto';
import { db, settings } from './db/drizzle';
import { and, eq } from 'drizzle-orm';
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

export interface ImageCreationMetadata {
	createdAt: string | null;
	platform: string;
}

type CreationLoader = (persisted: Readonly<Record<string, string>>) => Promise<string | null | ImageCreationMetadata>;
interface PersistedObservation {
	firstObservedAt: string;
	createdAt?: string;
	createdAtByPlatform?: Record<string, string>;
	platformByEnvironment?: Record<string, string>;
}

/** First observation is shared across tags/environments. Verified creation dates
 * belong to the selected platform: different children of an index may differ.
 * Remember each environment's platform so a failed daemon probe cannot reset
 * its cooldown or borrow another environment's creation date. */
export async function imageReleaseAgeStatus(
	imageName: string, digest: string, hours: number,
	loadCreatedAt?: CreationLoader,
	envId?: number | null
): Promise<ReleaseAgeObservation> {
	const { registry, repo } = parseImageReference(imageName);
	const key = 'release_age_seen_' + createHash('sha256').update(`${registry}/${repo}@${digest}`).digest('hex');
	await db.insert(settings).values({ key, value: JSON.stringify({ firstObservedAt: new Date().toISOString() }) }).onConflictDoNothing();
	async function readObservation() {
		const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, key));
		if (!row) throw new Error('Could not record when the image was first seen');
		const value = JSON.parse(row.value) as string | PersistedObservation;
		return { raw: row.value, record: typeof value === 'string' ? { firstObservedAt: value } : value };
	}
	let observation = await readObservation();
	let metadata: string | null | ImageCreationMetadata = null;
	if (hours > 0 && loadCreatedAt && !validImageCreatedAt(observation.record.createdAt)) {
		try { metadata = await loadCreatedAt(observation.record.createdAtByPlatform ?? {}); } catch { /* retain durable observation */ }
	}
	const environmentKey = envId == null ? 'local' : String(envId);
	const resolvedPlatform = typeof metadata === 'object' && metadata !== null ? metadata.platform : null;
	if (metadata === null) observation = await readObservation();
	const platform = resolvedPlatform ?? (metadata === null ? observation.record.platformByEnvironment?.[environmentKey] : null);
	const loaded = validImageCreatedAt(typeof metadata === 'object' && metadata !== null ? metadata.createdAt : metadata);
	const storedCreatedAt = (record: PersistedObservation) => validImageCreatedAt(platform ? record.createdAtByPlatform?.[platform] : record.createdAt);
	// Compare-and-swap preserves first observation and immutable metadata when
	// overlapping checks promote the same row or different platform children.
	while ((loaded && !storedCreatedAt(observation.record)) ||
		(resolvedPlatform && observation.record.platformByEnvironment?.[environmentKey] !== resolvedPlatform)) {
		const record = { ...observation.record };
		if (loaded && !storedCreatedAt(record)) {
			if (platform) record.createdAtByPlatform = { ...record.createdAtByPlatform, [platform]: loaded };
			else record.createdAt = loaded;
		}
		if (resolvedPlatform) {
			record.platformByEnvironment = { ...record.platformByEnvironment, [environmentKey]: resolvedPlatform };
		}
		const updated = await db.update(settings).set({ value: JSON.stringify(record) })
			.where(and(eq(settings.key, key), eq(settings.value, observation.raw))).returning({ value: settings.value });
		observation = await readObservation();
		if (updated.length) break;
	}
	const createdAt = storedCreatedAt(observation.record);
	const observedAt = createdAt ?? observation.record.firstObservedAt;
	return { remainingMs: releaseAgeRemainingMs(observedAt, hours), observedAt, source: createdAt ? 'created' : 'first-observed' };
}

export async function imageReleaseAgeRemainingMs(
	imageName: string, digest: string, hours: number,
	loadCreatedAt?: CreationLoader,
	envId?: number | null
): Promise<number> {
	if (hours === 0) return 0;
	return (await imageReleaseAgeStatus(imageName, digest, hours, loadCreatedAt, envId)).remainingMs;
}
