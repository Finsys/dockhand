/**
 * Shared utilities for container and environment auto-update tasks.
 */

import type { VulnerabilityCriteria } from '../../db';
import type { VulnerabilitySeverity } from '../../scanner';

/**
 * Parse image name and tag from a full image reference.
 * Handles various formats:
 * - nginx → ["nginx", "latest"]
 * - nginx:1.25 → ["nginx", "1.25"]
 * - registry.example.com:5000/myimage:v1 → ["registry.example.com:5000/myimage", "v1"]
 * - nginx:latest-dockhand-pending → ["nginx", "latest-dockhand-pending"]
 */
export function parseImageNameAndTag(imageName: string): [string, string] {
	// Handle digest-based images (return as-is with empty tag)
	if (imageName.includes('@sha256:')) {
		return [imageName, ''];
	}

	// Find the last colon that's part of the tag (not part of registry port)
	const lastColon = imageName.lastIndexOf(':');
	if (lastColon === -1) {
		return [imageName, 'latest'];
	}

	// Check if this colon is part of a registry port
	// Registry ports appear before a slash: registry:5000/image
	const afterColon = imageName.substring(lastColon + 1);
	if (afterColon.includes('/')) {
		// The colon is part of the registry, not the tag
		return [imageName, 'latest'];
	}

	// The colon separates repo from tag
	return [imageName.substring(0, lastColon), afterColon];
}

/**
 * Determine if an update should be blocked based on vulnerability criteria.
 */
export function shouldBlockUpdate(
	criteria: VulnerabilityCriteria,
	newScanSummary: VulnerabilitySeverity,
	currentScanSummary?: VulnerabilitySeverity
): { blocked: boolean; reason: string } {
	const totalVulns = newScanSummary.critical + newScanSummary.high + newScanSummary.medium + newScanSummary.low;

	switch (criteria) {
		case 'any':
			if (totalVulns > 0) {
				return {
					blocked: true,
					reason: `Found ${totalVulns} vulnerabilities (${newScanSummary.critical} critical, ${newScanSummary.high} high, ${newScanSummary.medium} medium, ${newScanSummary.low} low)`
				};
			}
			break;
		case 'critical_high':
			if (newScanSummary.critical > 0 || newScanSummary.high > 0) {
				return {
					blocked: true,
					reason: `Found ${newScanSummary.critical} critical and ${newScanSummary.high} high severity vulnerabilities`
				};
			}
			break;
		case 'critical':
			if (newScanSummary.critical > 0) {
				return {
					blocked: true,
					reason: `Found ${newScanSummary.critical} critical vulnerabilities`
				};
			}
			break;
		case 'more_than_current':
			if (currentScanSummary) {
				const currentTotal = currentScanSummary.critical + currentScanSummary.high + currentScanSummary.medium + currentScanSummary.low;
				if (totalVulns > currentTotal) {
					return {
						blocked: true,
						reason: `New image has ${totalVulns} vulnerabilities vs ${currentTotal} in current image`
					};
				}
			}
			break;
		case 'never':
		default:
			break;
	}

	return { blocked: false, reason: '' };
}

/**
 * Determine if an update should be deferred based on minimum image age.
 * @param createdDate - ISO date string of when the image was created/published
 * @param minAgeDays - Minimum age in days before the image is eligible for update
 * @returns Object with deferred flag, age in days, and reason string
 */
export function shouldDeferUpdate(
	createdDate: string,
	minAgeDays: number
): { deferred: boolean; ageDays: number; reason: string } {
	if (minAgeDays <= 0) {
		return { deferred: false, ageDays: 0, reason: '' };
	}

	const created = new Date(createdDate);
	if (isNaN(created.getTime())) {
		// If we can't parse the date, defer as a safety measure
		return {
			deferred: true,
			ageDays: 0,
			reason: `Could not parse image creation date: ${createdDate}`
		};
	}

	const now = new Date();
	const ageMs = now.getTime() - created.getTime();
	const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));

	// Sanity check: dates before 2013 (Docker's creation year) or in the future are likely
	// synthetic (e.g. reproducible builds using epoch zero). Treat as unparseable.
	if (created.getFullYear() < 2013 || ageMs < 0) {
		return {
			deferred: true,
			ageDays: 0,
			reason: `Image has suspicious creation date (${createdDate}), deferring as safety measure`
		};
	}

	if (ageDays < minAgeDays) {
		return {
			deferred: true,
			ageDays,
			reason: `Image is ${ageDays} day(s) old (minimum: ${minAgeDays})`
		};
	}

	return { deferred: false, ageDays, reason: '' };
}

/**
 * Determine if a security fix in the new image should bypass the age gate.
 * Compares critical + high vulnerability counts between current and new scans.
 * The new image must have strictly fewer critical+high CVEs to qualify as a security fix.
 *
 * @param currentScan - Vulnerability summary of the current running image
 * @param newScan - Vulnerability summary of the new image
 * @returns Object with bypass flag and reason
 */
export function shouldBypassAgeForSecurity(
	currentScan: VulnerabilitySeverity,
	newScan: VulnerabilitySeverity
): { bypass: boolean; reason: string } {
	const currentCritHigh = currentScan.critical + currentScan.high;
	const newCritHigh = newScan.critical + newScan.high;

	if (currentCritHigh > 0 && newCritHigh < currentCritHigh) {
		const fixed = currentCritHigh - newCritHigh;
		return {
			bypass: true,
			reason: `New image fixes ${fixed} critical/high CVE(s) (${currentCritHigh} → ${newCritHigh})`
		};
	}

	return { bypass: false, reason: '' };
}

/**
 * Check if a container is the Dockhand application itself.
 * Used to prevent Dockhand from updating its own container.
 */
export function isDockhandContainer(imageName: string): boolean {
	const lower = imageName.toLowerCase();
	// Match fnsys/dockhand, registry.example.com/dockhand, or plain dockhand
	return lower.includes('fnsys/dockhand') || /(?:^|\/)dockhand(?::|$)/.test(lower);
}

/**
 * Check if a container is a Hawser agent.
 * Official image: ghcr.io/finsys/hawser
 */
export function isHawserContainer(imageName: string): boolean {
	const lower = imageName.toLowerCase();
	return lower.includes('finsys/hawser') || lower.includes('ghcr.io/finsys/hawser');
}

/**
 * System container type - containers that cannot be updated from within Dockhand.
 */
export type SystemContainerType = 'dockhand' | 'hawser';

/**
 * Check if a container is a system container (Dockhand or Hawser).
 * System containers cannot be updated from within Dockhand because:
 * - Dockhand: Would need to stop itself to update
 * - Hawser: Would disconnect from the environment it's managing
 */
export function isSystemContainer(imageName: string): SystemContainerType | null {
	if (isDockhandContainer(imageName)) return 'dockhand';
	if (isHawserContainer(imageName)) return 'hawser';
	return null;
}

/**
 * Combine multiple scan summaries by taking the maximum of each severity level.
 */
export function combineScanSummaries(results: { summary: VulnerabilitySeverity }[]): VulnerabilitySeverity {
	return results.reduce((acc, result) => ({
		critical: Math.max(acc.critical, result.summary.critical),
		high: Math.max(acc.high, result.summary.high),
		medium: Math.max(acc.medium, result.summary.medium),
		low: Math.max(acc.low, result.summary.low),
		negligible: Math.max(acc.negligible, result.summary.negligible),
		unknown: Math.max(acc.unknown, result.summary.unknown)
	}), { critical: 0, high: 0, medium: 0, low: 0, negligible: 0, unknown: 0 });
}
