import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { listContainers, inspectContainer, checkImageUpdateAvailable, getTagArtifactKind } from '$lib/server/docker';
import { clearPendingContainerUpdates, addPendingContainerUpdate, getPendingContainerUpdates, getGlobalSemverConfig } from '$lib/server/db';
import { isSystemContainer, isPodmanInfraContainer } from '$lib/server/scheduler/tasks/update-utils';
import { isUpdateDisabledByLabel, isHiddenByLabel, getVersionPatternOverride } from '$lib/server/container-labels';
import { createJobResponse } from '$lib/server/sse';
import { checkNewerVersion } from '$lib/server/semver/check';
import type { NewerVersion } from '$lib/server/semver/find-newer';

export interface UpdateCheckResult {
	containerId: string;
	containerName: string;
	imageName: string;
	hasUpdate: boolean;
	currentDigest?: string;
	newDigest?: string;
	error?: string;
	isLocalImage?: boolean;
	systemContainer?: 'dockhand' | 'hawser' | null;
	updateDisabled?: boolean;
	/** A newer VERSION tag is published for a pinned image (advisory, never auto-applied). */
	newerVersion?: NewerVersion;
}

/**
 * GET = READ the cached result of the last update check (no side effects, does NOT
 * trigger a new check). Returns the containers currently flagged as having a pending
 * image update. Use POST (below) to actually run a fresh check. (issue #1266)
 *
 * @openapi
 * summary: Read the cached pending image-update records for an environment (no fresh check; requires the 'view' permission)
 * description: Returns the containers currently flagged as having a pending image update from the last check. Does not trigger a new check — use POST to run a fresh check.
 * query: env:integer The target environment ID (omit for the local/default Docker host) (from GET /api/environments)
 * resp-200: {environmentId:integer!, pendingUpdates:array<{containerId:string!, containerName:string!, currentImage:string!, checkedAt:string}>!}
 * resp-400: Environment ID required
 * resp-403: Permission denied
 * resp-500: Failed to get pending updates
 */
export const GET: RequestHandler = async ({ url, cookies }) => {
	const auth = await authorize(cookies);

	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	if (!envIdNum) {
		return json({ error: 'Environment ID required' }, { status: 400 });
	}

	if (auth.authEnabled && !await auth.can('containers', 'view', envIdNum)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const pendingUpdates = await getPendingContainerUpdates(envIdNum);
		return json({
			environmentId: envIdNum,
			pendingUpdates: pendingUpdates.map(u => ({
				containerId: u.containerId,
				containerName: u.containerName,
				currentImage: u.currentImage,
				checkedAt: u.checkedAt
			}))
		});
	} catch (error: any) {
		console.error('Error getting pending updates:', error);
		return json({ error: 'Failed to get pending updates', details: error.message }, { status: 500 });
	}
};

/**
 * POST = TRIGGER a fresh update check across all containers (job-based).
 * Returns progress events during checking, final result when done.
 *
 * @openapi
 * summary: Trigger a fresh image-update check across all (non-hidden, non-podman-infra) containers in an environment
 * query: env:integer The target environment ID (omit for the local/default Docker host) (from GET /api/environments)
 * resp-200: text/event-stream job stream ("progress" events with {checked,total}, final "result" event with {total,updatesFound,results}) — or, with "Accept: application/json", the final result as plain JSON
 * resp-403: Permission denied
 */
export const POST: RequestHandler = async ({ url, cookies, request }) => {
	const auth = await authorize(cookies);

	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	// Need at least view permission
	if (auth.authEnabled && !await auth.can('containers', 'view', envIdNum)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	return createJobResponse(async (send) => {
		// Clear existing pending updates for this environment before checking
		if (envIdNum) {
			await clearPendingContainerUpdates(envIdNum);
		}

		const allContainers = await listContainers(true, envIdNum);
		// Skip:
		// - dockhand.hidden=true (invisible to user, so no update alerts) (#1083)
		// - Podman pod-infra containers (named <pod>-infra, never published) (#1221)
		const containers = allContainers.filter(
			(c) => !isHiddenByLabel(c.labels) && !isPodmanInfraContainer(c.name)
		);

		send('progress', { checked: 0, total: containers.length });

		// Semver "newer version tag" detection is a global setting; when enabled, each
		// pinned-version container is also compared against the registry's tag list.
		// The scheduled check reads the same config.
		const semverConfig = await getGlobalSemverConfig();
		const semverEnabled = semverConfig.enabled;
		const semverOptions = {
			maxBump: semverConfig.maxBump,
			matchFlavor: semverConfig.matchFlavor,
			includePrerelease: semverConfig.includePrerelease
		} as const;

		// Check container for updates
		let checked = 0;
		const checkContainer = async (container: typeof containers[0]): Promise<UpdateCheckResult> => {
			try {
				const inspectData = await inspectContainer(container.id, envIdNum) as any;
				const imageName = inspectData.Config?.Image;
				const currentImageId = inspectData.Image;

				if (!imageName) {
					return {
						containerId: container.id,
						containerName: container.name,
						imageName: container.image,
						hasUpdate: false,
						error: 'Could not determine image name',
						systemContainer: isSystemContainer(container.image) || null
					};
				}

				const updateDisabled = isUpdateDisabledByLabel(inspectData.Config?.Labels);
				if (updateDisabled) {
					return {
						containerId: container.id,
						containerName: container.name,
						imageName,
						hasUpdate: false,
						systemContainer: isSystemContainer(imageName) || null,
						updateDisabled: true
					};
				}

				const result = await checkImageUpdateAvailable(imageName, currentImageId, envIdNum);

				// System containers (Dockhand itself, Hawser) have their own update path and are
				// never shown/counted as a container update, so skip the extra registry call and
				// never emit a newerVersion for them - otherwise the "found updates" notification
				// counts a suggestion the UI deliberately hides (#1466).
				const systemContainer = isSystemContainer(imageName) || null;

				// Newer-version-tag detection (opt-in). Skips instantly for floating tags,
				// so it only hits the registry for pinned versions. Never throws.
				const newerVersion = semverEnabled && !systemContainer
					? await checkNewerVersion(imageName, {
							...semverOptions,
							versionPattern: getVersionPatternOverride(inspectData.Config?.Labels)
						}, getTagArtifactKind).catch(() => null)
					: null;

				return {
					containerId: container.id,
					containerName: container.name,
					imageName,
					hasUpdate: result.hasUpdate,
					currentDigest: result.currentDigest,
					newDigest: result.registryDigest,
					error: result.error,
					isLocalImage: result.isLocalImage,
					systemContainer,
					updateDisabled,
					newerVersion: newerVersion ?? undefined
				};
			} catch (error: any) {
				return {
					containerId: container.id,
					containerName: container.name,
					imageName: container.image,
					hasUpdate: false,
					error: error.message,
					systemContainer: isSystemContainer(container.image) || null
				};
			}
		};

		// Sliding window concurrency limit to avoid DNS threadpool saturation (#676).
		const CONCURRENCY = 20;
		const results: UpdateCheckResult[] = new Array(containers.length);
		let next = 0;
		async function runNext(): Promise<void> {
			while (next < containers.length) {
				const idx = next++;
				results[idx] = await checkContainer(containers[idx]);
				checked++;
				send('progress', { checked, total: containers.length });
			}
		}
		await Promise.all(Array.from({ length: Math.min(CONCURRENCY, containers.length) }, () => runNext()));

		const updatesFound = results.filter(r => r.hasUpdate && !r.systemContainer && !r.updateDisabled).length;

		// Persist a row for anything worth showing on reload: a digest update, a
		// newer-version-tag (semver) suggestion, or both. A pure-semver row (no
		// digest update) still persists so the badge survives a page reload.
		if (envIdNum) {
			for (const result of results) {
				if (result.systemContainer || result.updateDisabled) continue;
				const hasImageUpdate = result.hasUpdate;
				if (!hasImageUpdate && !result.newerVersion) continue;
				await addPendingContainerUpdate(
					envIdNum,
					result.containerId,
					result.containerName,
					result.imageName,
					{ hasImageUpdate, newerVersion: result.newerVersion ?? null }
				);
			}
		}

		send('result', {
			total: containers.length,
			updatesFound,
			results
		});
	}, request);
};
