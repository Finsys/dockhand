import { createHash } from 'node:crypto';
import { db, settings } from './db/drizzle';
import { eq } from 'drizzle-orm';
import { deleteSetting, getSetting, setEnvSetting, setSetting } from './db';
import { parseMinimumReleaseAgeHours, releaseAgeRemainingMs, resolveMinimumReleaseAgeConfig, type MinimumReleaseAgeConfig } from './minimum-release-age-core';
import { parseImageReference, isDockerHub } from './registry/image-ref';

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

/** Docker Hub exposes push time for tags; unlike image config `created`, it changes
 * when a mutable tag is re-pushed. Other registries use first observation below. */
async function dockerHubLastPushed(imageName: string): Promise<string | null> {
	const { registry, repo, tag } = parseImageReference(imageName);
	if (!isDockerHub(registry) || imageName.includes('@')) return null;
	const [namespace, ...name] = repo.split('/');
	if (!namespace || name.length !== 1) return null;
	try {
		const url = `https://hub.docker.com/v2/namespaces/${encodeURIComponent(namespace)}/repositories/${encodeURIComponent(name[0])}/tags/${encodeURIComponent(tag)}`;
		const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(5000) });
		if (!response.ok) return null;
		const data = await response.json() as { tag_last_pushed?: unknown };
		const timestamp = data.tag_last_pushed;
		return typeof timestamp === 'string' && Number.isFinite(Date.parse(timestamp)) ? timestamp : null;
	} catch {
		return null;
	}
}

/** Use Docker Hub's tag push time when available. Private tags and transient Hub
 * API failures use the persisted first-observed digest cooldown instead. */
export async function imageReleaseAgeRemainingMs(imageName: string, digest: string, hours: number): Promise<number> {
	if (hours === 0) return 0;
	const { registry } = parseImageReference(imageName);
	if (isDockerHub(registry) && !imageName.includes('@')) {
		const pushed = await dockerHubLastPushed(imageName);
		if (pushed) return releaseAgeRemainingMs(pushed, hours);
	}
	return observeImageDigest(imageName, digest, hours);
}

/** Atomic insert preserves the earliest observation even when checks run concurrently. */
export async function observeImageDigest(imageName: string, digest: string, hours: number): Promise<number> {
	if (hours === 0) return 0;
	const { registry, repo } = parseImageReference(imageName);
	const key = 'release_age_seen_' + createHash('sha256').update(`${registry}/${repo}@${digest}`).digest('hex');
	const now = new Date().toISOString();
	await db.insert(settings).values({ key, value: JSON.stringify(now) }).onConflictDoNothing();
	const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, key));
	if (!row) throw new Error('Could not record when the image was first seen');
	return releaseAgeRemainingMs(JSON.parse(row.value), hours);
}
