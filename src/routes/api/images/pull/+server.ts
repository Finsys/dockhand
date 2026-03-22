import { json } from '@sveltejs/kit';
import { pullImage, buildRegistryAuthHeader } from '$lib/server/docker';
import type { RequestHandler } from './$types';
import { getScannerSettings, scanImage } from '$lib/server/scanner';
import { saveVulnerabilityScan, getEnvironment } from '$lib/server/db';
import { authorize } from '$lib/server/authorize';
import { auditImage } from '$lib/server/audit';
import { sendEdgeStreamRequest, isEdgeConnected } from '$lib/server/hawser';
import { createJobResponse } from '$lib/server/sse';

/**
 * Check if environment is edge mode
 */
async function isEdgeMode(envId?: number): Promise<{ isEdge: boolean; environmentId?: number }> {
	if (!envId) {
		return { isEdge: false };
	}
	const env = await getEnvironment(envId);
	if (env?.connectionType === 'hawser-edge') {
		return { isEdge: true, environmentId: envId };
	}
	return { isEdge: false };
}

/**
 * Build image pull URL with proper tag handling
 */
function buildPullUrl(imageName: string): string {
	let fromImage = imageName;
	let tag = 'latest';

	if (imageName.includes('@')) {
		fromImage = imageName;
		tag = '';
	} else if (imageName.includes(':')) {
		const lastColonIndex = imageName.lastIndexOf(':');
		const potentialTag = imageName.substring(lastColonIndex + 1);
		if (!potentialTag.includes('/')) {
			fromImage = imageName.substring(0, lastColonIndex);
			tag = potentialTag;
		}
	}

	return tag
		? `/images/create?fromImage=${encodeURIComponent(fromImage)}&tag=${encodeURIComponent(tag)}`
		: `/images/create?fromImage=${encodeURIComponent(fromImage)}`;
}

export const POST: RequestHandler = async (event) => {
	const { request, url, cookies } = event;
	const auth = await authorize(cookies);

	const envIdParam = url.searchParams.get('env');
	const envId = envIdParam ? parseInt(envIdParam) : undefined;

	// Permission check with environment context
	if (auth.authEnabled && !await auth.can('images', 'pull', envId)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	// Environment access check (enterprise only)
	if (envId && auth.isEnterprise && !await auth.canAccessEnvironment(envId)) {
		return json({ error: 'Access denied to this environment' }, { status: 403 });
	}

	const { image, scanAfterPull } = await request.json();

	// If scanAfterPull is explicitly false, skip scan-on-pull (caller will handle scanning)
	const skipScanOnPull = scanAfterPull === false;

	// Audit log the pull attempt
	await auditImage(event, 'pull', image, image, envId);

	// Check if this is an edge environment
	const edgeCheck = await isEdgeMode(envId);

	return createJobResponse(async (send) => {
		const sendData = (data: unknown) => {
			send('progress', data);
		};

		/**
		 * Handle scan-on-pull after image is pulled
		 */
		const handleScanOnPull = async () => {
			if (skipScanOnPull) return;

			const { scanner } = await getScannerSettings(envId);
			if (scanner !== 'none') {
				sendData({ status: 'scanning', message: 'Starting vulnerability scan...' });

				try {
					const results = await scanImage(image, envId, (progress) => {
						sendData({ status: 'scan-progress', ...progress });
					});

					for (const result of results) {
						await saveVulnerabilityScan({
							environmentId: envId ?? null,
							imageId: result.imageId,
							imageName: result.imageName,
							scanner: result.scanner,
							scannedAt: result.scannedAt,
							scanDuration: result.scanDuration,
							criticalCount: result.summary.critical,
							highCount: result.summary.high,
							mediumCount: result.summary.medium,
							lowCount: result.summary.low,
							negligibleCount: result.summary.negligible,
							unknownCount: result.summary.unknown,
							vulnerabilities: result.vulnerabilities,
							error: result.error ?? null
						});
					}

					const totalVulns = results.reduce((sum, r) => sum + r.vulnerabilities.length, 0);
					sendData({
						status: 'scan-complete',
						message: `Scan complete - found ${totalVulns} vulnerabilities`,
						results
					});
				} catch (scanError) {
					console.error('Scan-on-pull failed:', scanError);
					sendData({
						status: 'scan-error',
						error: scanError instanceof Error ? scanError.message : String(scanError)
					});
				}
			}
		};

		console.log(`Starting pull for image: ${image}${edgeCheck.isEdge ? ' (edge mode)' : ''}`);

		if (edgeCheck.isEdge && edgeCheck.environmentId) {
			if (!isEdgeConnected(edgeCheck.environmentId)) {
				sendData({ status: 'error', error: 'Edge agent not connected' });
				send('result', { status: 'error', error: 'Edge agent not connected' });
				throw new Error('Edge agent not connected');
			}

			const pullUrl = buildPullUrl(image);
			const authHeaders = await buildRegistryAuthHeader(image);

			await new Promise<void>((resolve, reject) => {
				const { cancel } = sendEdgeStreamRequest(
					edgeCheck.environmentId!,
					'POST',
					pullUrl,
					{
						onData: (data: string) => {
							try {
								const decoded = Buffer.from(data, 'base64').toString('utf-8');
								const lines = decoded.split('\n').filter((line) => line.trim());
								for (const line of lines) {
									try {
										sendData(JSON.parse(line));
									} catch {
										// Ignore parse errors for partial lines
									}
								}
							} catch {
								try {
									sendData(JSON.parse(data));
								} catch {
									// Ignore
								}
							}
						},
						onEnd: async () => {
							sendData({ status: 'complete' });
							await handleScanOnPull();
							send('result', { status: 'complete' });
							resolve();
						},
						onError: (error: string) => {
							console.error('Edge pull error:', error);
							sendData({ status: 'error', error });
							send('result', { status: 'error', error });
							reject(new Error(error));
						}
					},
					undefined,
					authHeaders
				);

				// Store cancel reference (not used currently but available)
				void cancel;
			});
		} else {
			try {
				await pullImage(image, (progress) => {
					sendData(progress);
				}, envId);

				sendData({ status: 'complete' });
				await handleScanOnPull();
				send('result', { status: 'complete' });
			} catch (error) {
				console.error('Error pulling image:', error);
				const errMsg = String(error);
				sendData({ status: 'error', error: errMsg });
				send('result', { status: 'error', error: errMsg });
				throw error;
			}
		}
	}, request);
};
