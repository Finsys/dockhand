import { json, type RequestHandler } from '@sveltejs/kit';
import { getEnvSetting, setEnvSetting, getEnvironment, setSetting } from '$lib/server/db';
import {
	checkScannerAvailability,
	getScannerVersions,
	checkScannerUpdates,
	checkScannerNewerVersions,
	cleanupScannerCache,
	getGlobalScannerDefaults,
	type ScannerType
} from '$lib/server/scanner';
import { removeImage, listImages } from '$lib/server/docker';
import { authorize } from '$lib/server/authorize';

export interface ScannerSettings {
	scanner: ScannerType;
	grypeArgs: string;
	trivyArgs: string;
	grypeImage: string;
	trivyImage: string;
}

/**
 * @openapi
 * summary: Get the vulnerability-scanner settings for an environment, plus (unless settingsOnly) scanner availability, versions and optional update info
 * query: env:integer Environment id to read scanner settings for (falls back to global defaults) (from GET /api/environments)
 * query: checkUpdates:boolean When true, also check the scanner images for available updates (slower)
 * query: checkNewerVersions:boolean When true, also ask the registry whether a newer scanner RELEASE exists (slower)
 * query: settingsOnly:boolean When true, return only settings + defaults and skip the Docker availability/version checks
 * resp-200: Scanner settings and (unless settingsOnly) availability, versions, updates, newerVersions and defaults
 * resp-403: Permission denied (missing settings:view for the environment)
 * resp-500: Failed to read the scanner settings
 */
export const GET: RequestHandler = async ({ url, cookies }) => {
	const auth = await authorize(cookies);

	const envId = url.searchParams.get('env');
	const parsedEnvId = envId ? parseInt(envId) : undefined;
	const checkUpdates = url.searchParams.get('checkUpdates') === 'true';
	const checkNewer = url.searchParams.get('checkNewerVersions') === 'true';
	const settingsOnly = url.searchParams.get('settingsOnly') === 'true';

	// Permission check with environment context
	if (auth.authEnabled && !await auth.can('settings', 'view', parsedEnvId)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {

		// Get global defaults from general settings (used for reset to defaults)
		const globalDefaults = await getGlobalScannerDefaults();

		// Get environment-specific settings (falls back to global defaults if not set)
		const settings: ScannerSettings = {
			scanner: await getEnvSetting('vulnerability_scanner', parsedEnvId) || 'none',
			grypeArgs: await getEnvSetting('grype_cli_args', parsedEnvId) || globalDefaults.grypeArgs,
			trivyArgs: await getEnvSetting('trivy_cli_args', parsedEnvId) || globalDefaults.trivyArgs,
			grypeImage: globalDefaults.grypeImage,
			trivyImage: globalDefaults.trivyImage
		};

		// Fast path: return just settings without Docker checks
		if (settingsOnly) {
			return json({
				settings,
				defaults: globalDefaults
			});
		}

		// Check scanner availability and versions in parallel
		const [availability, versions] = await Promise.all([
			checkScannerAvailability(parsedEnvId),
			getScannerVersions(parsedEnvId)
		]);

		// Optionally check for updates (slower operation)
		let updates = undefined;
		if (checkUpdates) {
			updates = await checkScannerUpdates(parsedEnvId);
		}

		// Opt-in: reaches the registry for the repo's tag list, so it is not on the
		// path of an ordinary settings read.
		let newerVersions = undefined;
		if (checkNewer) {
			newerVersions = await checkScannerNewerVersions();
		}

		return json({
			settings,
			availability,
			versions,
			updates,
			newerVersions,
			defaults: globalDefaults
		});
	} catch (error) {
		console.error('Failed to get scanner settings:', error);
		return json({ error: 'Failed to get scanner settings' }, { status: 500 });
	}
};

/** Per-environment scanner settings; an absent field is left as it was. */
async function saveEnvScannerSettings(
	envId: number | undefined,
	values: { scanner?: unknown; grypeArgs?: unknown; trivyArgs?: unknown }
): Promise<void> {
	const byKey: Array<[string, unknown]> = [
		['vulnerability_scanner', values.scanner],
		['grype_cli_args', values.grypeArgs],
		['trivy_cli_args', values.trivyArgs]
	];
	for (const [key, value] of byKey) {
		if (value !== undefined) await setEnvSetting(key, value, envId);
	}
}

/** The instance-wide scanner images. Callers gate this on administrator access. */
async function saveScannerImages(values: { grypeImage?: unknown; trivyImage?: unknown }): Promise<void> {
	if (typeof values.grypeImage === 'string') await setSetting('default_grype_image', values.grypeImage);
	if (typeof values.trivyImage === 'string') await setSetting('default_trivy_image', values.trivyImage);
}

/**
 * @openapi
 * summary: Save the vulnerability-scanner settings for an environment
 * body: {scanner:string, grypeArgs:string, trivyArgs:string, envId:integer, grypeImage:string, trivyImage:string}
 * body-example: {"scanner":"grype","grypeArgs":"-o json -v {image}","trivyArgs":"image --format json {image}","envId":1}
 * resp-200: {success:boolean!, settings:{scanner:string!, grypeArgs:string!, trivyArgs:string!}}
 * resp-400: Invalid scanner type (must be none, grype, trivy or both)
 * resp-403: Permission denied (missing settings:edit for the environment, or not an administrator when changing a scanner image)
 * resp-500: Failed to save the scanner settings
 */
export const POST: RequestHandler = async ({ request, url, cookies }) => {
	const auth = await authorize(cookies);

	try {
		const body = await request.json();
		const { scanner, grypeArgs, trivyArgs, grypeImage, trivyImage, envId } = body;
		const parsedEnvId = envId ? parseInt(envId) : undefined;

		// Permission check with environment context
		if (auth.authEnabled && !await auth.can('settings', 'edit', parsedEnvId)) {
			return json({ error: 'Permission denied' }, { status: 403 });
		}

		// Validate scanner type
		const validScanners: ScannerType[] = ['none', 'grype', 'trivy', 'both'];
		if (scanner && !validScanners.includes(scanner)) {
			return json({ error: 'Invalid scanner type' }, { status: 400 });
		}

		await saveEnvScannerSettings(parsedEnvId, { scanner, grypeArgs, trivyArgs });

		// The scanner images are INSTANCE-wide, not per environment, so an editor
		// scoped to one environment must not set them. can() cannot express that:
		// without an environmentId it reads the merge of EVERY role the user holds,
		// scoped ones included, which is wider than the per-env check, not narrower.
		// Admin is the one unambiguous answer available here.
		if (grypeImage !== undefined || trivyImage !== undefined) {
			if (auth.authEnabled && !auth.isAdmin) {
				return json({ error: 'Changing the scanner image requires administrator access' }, { status: 403 });
			}
			await saveScannerImages({ grypeImage, trivyImage });
		}

		// Get global defaults for fallback
		const globalDefaults = await getGlobalScannerDefaults();

		return json({
			success: true,
			settings: {
				scanner: await getEnvSetting('vulnerability_scanner', parsedEnvId) || 'none',
				grypeArgs: await getEnvSetting('grype_cli_args', parsedEnvId) || globalDefaults.grypeArgs,
				trivyArgs: await getEnvSetting('trivy_cli_args', parsedEnvId) || globalDefaults.trivyArgs,
				grypeImage: globalDefaults.grypeImage,
				trivyImage: globalDefaults.trivyImage
			}
		});
	} catch (error) {
		console.error('Failed to save scanner settings:', error);
		return json({ error: 'Failed to save scanner settings' }, { status: 500 });
	}
};

/**
 * @openapi
 * summary: Remove the scanner images (grype/trivy) and clean up scanner database volumes for an environment
 * query: removeImages:boolean Must be true to actually perform the removal (required)
 * query: scanner:string Which scanner image to remove (grype or trivy); omit to remove both
 * query: env:integer Environment id whose scanner images should be removed (required) (from GET /api/environments)
 * resp-200: {success:boolean!, removed:array<string>, errors:array<string>}
 * resp-400: The removeImages parameter is required, or the environment id is missing
 * resp-403: Permission denied (missing settings:edit for the environment)
 * resp-404: Environment not found
 * resp-500: Failed to remove the scanner images
 */
export const DELETE: RequestHandler = async ({ url, cookies }) => {
	const auth = await authorize(cookies);

	const removeImagesFlag = url.searchParams.get('removeImages') === 'true';
	const scanner = url.searchParams.get('scanner'); // 'grype', 'trivy', or null for both
	const envId = url.searchParams.get('env');
	const parsedEnvId = envId ? parseInt(envId) : undefined;

	// Permission check with environment context
	if (auth.authEnabled && !await auth.can('settings', 'edit', parsedEnvId)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {

		if (!removeImagesFlag) {
			return json({ error: 'removeImages parameter required' }, { status: 400 });
		}

		if (!parsedEnvId) {
			return json({ error: 'Environment ID required' }, { status: 400 });
		}
		const env = await getEnvironment(parsedEnvId);
		if (!env) {
			return json({ error: 'Environment not found' }, { status: 404 });
		}

		const images = await listImages(parsedEnvId);

		const removed: string[] = [];
		const errors: string[] = [];

		// Get configured scanner images
		const globalDefaults = await getGlobalScannerDefaults();

		// Determine which images to remove
		const scannersToRemove: ('grype' | 'trivy')[] =
			scanner === 'grype' ? ['grype'] :
			scanner === 'trivy' ? ['trivy'] :
			['grype', 'trivy'];

		for (const scannerType of scannersToRemove) {
			const imageName = scannerType === 'grype' ? globalDefaults.grypeImage.split(':')[0] : globalDefaults.trivyImage.split(':')[0];

			// Find the image
			const image = images.find((img) =>
				img.tags?.some((tag: string) => tag.includes(imageName))
			);

			if (image) {
				try {
					await removeImage(image.id, true, parsedEnvId);
					removed.push(scannerType);
				} catch (err) {
					const errMsg = err instanceof Error ? err.message : String(err);
					console.error(`Failed to remove ${scannerType} image:`, err);
					errors.push(`${scannerType}: ${errMsg}`);
				}
			}
		}

		// Also cleanup scanner database cache (volumes + bind mount dirs)
		await cleanupScannerCache(parsedEnvId);

		return json({
			success: true,
			removed,
			errors: errors.length > 0 ? errors : undefined
		});
	} catch (error) {
		console.error('Failed to remove scanner images:', error);
		return json({ error: 'Failed to remove scanner images' }, { status: 500 });
	}
};
