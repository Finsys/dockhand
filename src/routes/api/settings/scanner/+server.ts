import { json, type RequestHandler } from '@sveltejs/kit';
import { getEnvSetting, setEnvSetting, getEnvironment, setSetting } from '$lib/server/db';
import {
	checkScannerAvailability,
	getScannerVersions,
	checkScannerUpdates,
	cleanupScannerVolumes,
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

export const GET: RequestHandler = async ({ url, cookies }) => {
	const auth = await authorize(cookies);

	const envId = url.searchParams.get('env');
	const parsedEnvId = envId ? parseInt(envId) : undefined;
	const checkUpdates = url.searchParams.get('checkUpdates') === 'true';
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

		return json({
			settings,
			availability,
			versions,
			updates,
			defaults: globalDefaults
		});
	} catch (error) {
		console.error('Failed to get scanner settings:', error);
		return json({ error: 'Failed to get scanner settings' }, { status: 500 });
	}
};

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

		// Save environment-specific settings
		if (scanner !== undefined) {
			await setEnvSetting('vulnerability_scanner', scanner, parsedEnvId);
		}
		if (grypeArgs !== undefined) {
			await setEnvSetting('grype_cli_args', grypeArgs, parsedEnvId);
		}
		if (trivyArgs !== undefined) {
			await setEnvSetting('trivy_cli_args', trivyArgs, parsedEnvId);
		}
		if (grypeImage !== undefined && typeof grypeImage === 'string') {
			await setSetting('default_grype_image', grypeImage);
		}
		if (trivyImage !== undefined && typeof trivyImage === 'string') {
			await setSetting('default_trivy_image', trivyImage);
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

		// Also cleanup scanner database volumes
		await cleanupScannerVolumes(parsedEnvId);

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
