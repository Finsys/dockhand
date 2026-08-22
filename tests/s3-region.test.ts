/**
 * Unit tests for the S3 region helpers. A bucket in a region behind the generic
 * s3.amazonaws.com endpoint returns 301; the region picker fixes that by building
 * the regional endpoint and by passing AWS_DEFAULT_REGION. These lock the pure
 * pieces of that logic.
 */
import { describe, test, expect } from 'bun:test';
import { regionalEndpoint, extractS3Region, isConcreteRegion, CUSTOM_REGION, AWS_REGIONS } from '../src/lib/utils/s3-region';

describe('regionalEndpoint', () => {
	test('builds the AWS regional endpoint host', () => {
		expect(regionalEndpoint('eu-north-1')).toBe('s3.eu-north-1.amazonaws.com');
		expect(regionalEndpoint('us-east-1')).toBe('s3.us-east-1.amazonaws.com');
	});
});

describe('extractS3Region', () => {
	test('recovers the region from a regional endpoint (dot and dash forms)', () => {
		expect(extractS3Region('s3.eu-north-1.amazonaws.com')).toBe('eu-north-1');
		expect(extractS3Region('s3-eu-west-1.amazonaws.com')).toBe('eu-west-1');
	});

	test('returns empty for the generic endpoint (no region segment)', () => {
		expect(extractS3Region('s3.amazonaws.com')).toBe('');
	});

	test('returns empty for non-AWS hosts (MinIO / Wasabi / custom)', () => {
		expect(extractS3Region('minio:9000')).toBe('');
		expect(extractS3Region('s3.wasabisys.com')).toBe('');
		expect(extractS3Region('s3.eu-central-1.wasabisys.com')).toBe('');
		expect(extractS3Region('localhost:9000')).toBe('');
	});

	test('round-trips with regionalEndpoint for every offered region', () => {
		for (const r of AWS_REGIONS) {
			expect(extractS3Region(regionalEndpoint(r))).toBe(r);
		}
	});
});

describe('isConcreteRegion', () => {
	test('true only for a real region', () => {
		expect(isConcreteRegion('eu-north-1')).toBe(true);
	});
	test('false for the custom sentinel, empty, null, undefined', () => {
		expect(isConcreteRegion(CUSTOM_REGION)).toBe(false);
		expect(isConcreteRegion('')).toBe(false);
		expect(isConcreteRegion(null)).toBe(false);
		expect(isConcreteRegion(undefined)).toBe(false);
	});
});
