/**
 * S3 region helpers for the backup destination form. Dependency-free so they can
 * be unit-tested without the Svelte component.
 *
 * An AWS bucket lives in one region; the generic s3.amazonaws.com endpoint doesn't
 * know which and returns 301. Selecting a region builds the regional endpoint AND
 * passes AWS_DEFAULT_REGION, either of which lets restic reach the bucket.
 */

/** Sentinel value the region picker uses for "not an AWS region" (MinIO/Wasabi/etc). */
export const CUSTOM_REGION = '__custom__';

/** AWS regions offered by the S3 region picker. Selecting one auto-fills the regional
 *  endpoint; "Custom" leaves the endpoint editable for MinIO / Wasabi / other providers. */
export const AWS_REGIONS = [
	'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2',
	'eu-north-1', 'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-central-1', 'eu-central-2', 'eu-south-1', 'eu-south-2',
	'ca-central-1', 'sa-east-1',
	'ap-south-1', 'ap-southeast-1', 'ap-southeast-2', 'ap-southeast-3', 'ap-northeast-1', 'ap-northeast-2', 'ap-northeast-3', 'ap-east-1',
	'me-south-1', 'me-central-1', 'af-south-1'
];

/** The regional S3 endpoint host for an AWS region, e.g. s3.eu-north-1.amazonaws.com. */
export function regionalEndpoint(region: string): string {
	return `s3.${region}.amazonaws.com`;
}

/**
 * Recover the AWS region from an endpoint host so the picker can show it on edit.
 * Matches s3.<region>.amazonaws.com and s3-<region>.amazonaws.com (older form).
 * Returns '' for the generic endpoint or any non-AWS host (MinIO, Wasabi, ...).
 */
export function extractS3Region(host: string): string {
	const m = host.match(/^s3[.-]([a-z0-9-]+)\.amazonaws\.com$/i);
	// s3.amazonaws.com itself has no region segment (the capture would be undefined).
	return m && m[1] ? m[1] : '';
}

/** True when a picker value is a real region (not the custom sentinel or empty). */
export function isConcreteRegion(region: string | undefined | null): boolean {
	return !!region && region !== CUSTOM_REGION;
}
