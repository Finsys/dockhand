import { describe, test, expect } from 'bun:test';
import { findingsToSarif } from '../src/lib/utils/sarif';
import type { Finding } from '../src/lib/utils/vulnerability';

function finding(over: Partial<Finding> = {}): Finding {
	return {
		key: 'k',
		cve: 'CVE-2024-0001',
		package: 'openssl',
		severity: 'high',
		installedVersion: '1.1.1',
		fixedVersion: '1.1.1w',
		imageId: 'sha256:abc',
		imageName: 'nginx:latest',
		description: 'A flaw in openssl',
		link: 'https://nvd.nist.gov/vuln/detail/CVE-2024-0001',
		scannedAt: '2026-07-01T00:00:00.000Z',
		...over
	};
}

describe('findingsToSarif', () => {
	test('emits a valid SARIF 2.1.0 skeleton', () => {
		const log = findingsToSarif([finding()]);
		expect(log.version).toBe('2.1.0');
		expect(log.$schema).toContain('sarif-2.1.0');
		expect(log.runs).toHaveLength(1);
		expect(log.runs[0].tool.driver.name).toBe('Dockhand');
	});

	test('maps severity to SARIF level', () => {
		const log = findingsToSarif([
			finding({ cve: 'C1', severity: 'critical' }),
			finding({ cve: 'C2', severity: 'high' }),
			finding({ cve: 'C3', severity: 'medium' }),
			finding({ cve: 'C4', severity: 'low' }),
			finding({ cve: 'C5', severity: 'unknown' })
		]);
		const levels = log.runs[0].results!.map((r) => r.level);
		expect(levels).toEqual(['error', 'error', 'warning', 'note', 'none']);
	});

	test('creates one rule per distinct CVE (deduped)', () => {
		const log = findingsToSarif([
			finding({ cve: 'CVE-1', package: 'a' }),
			finding({ cve: 'CVE-1', package: 'b' }), // same CVE, different package
			finding({ cve: 'CVE-2', package: 'c' })
		]);
		const rules = log.runs[0].tool.driver.rules!;
		expect(rules.map((r) => r.id).sort()).toEqual(['CVE-1', 'CVE-2']);
		// but every finding is still its own result
		expect(log.runs[0].results).toHaveLength(3);
	});

	test('rule carries helpUri and security-severity property', () => {
		const log = findingsToSarif([finding({ cve: 'CVE-X', severity: 'critical', link: 'https://example.test/x' })]);
		const rule = log.runs[0].tool.driver.rules![0];
		expect(rule.helpUri).toBe('https://example.test/x');
		expect((rule.properties as any)['security-severity']).toBe('9.5');
	});

	test('falls back to NVD helpUri when finding has no link', () => {
		const log = findingsToSarif([finding({ cve: 'CVE-NOLINK', link: undefined })]);
		expect(log.runs[0].tool.driver.rules![0].helpUri).toBe('https://nvd.nist.gov/vuln/detail/CVE-NOLINK');
	});

	test('result has a stable fingerprint and image/package metadata', () => {
		const log = findingsToSarif([finding({ imageId: 'sha256:xyz', cve: 'CVE-9', package: 'zlib', installedVersion: '1.2' })]);
		const res = log.runs[0].results![0];
		expect(res.partialFingerprints!.dockhandFinding).toBe('sha256:xyz|CVE-9|zlib|1.2');
		expect((res.properties as any).imageName).toBe('nginx:latest');
		// URI is repo-relative and encodes the colon so `nginx:` isn't a scheme.
		expect(res.locations![0].physicalLocation!.artifactLocation!.uri).toBe('images/nginx%3Alatest/zlib');
	});

	test('artifactLocation.uri is a RELATIVE reference (image ref colon not a scheme)', () => {
		// GitHub code scanning drops results whose uri is an absolute URI. An image
		// ref like `nginx:latest` or `reg:5000/app@sha256:...` must stay relative.
		for (const imageName of ['nginx:latest', 'myreg:5000/app', 'app@sha256:deadbeef']) {
			const log = findingsToSarif([finding({ imageName, package: 'openssl' })]);
			const uri = log.runs[0].results![0].locations![0].physicalLocation!.artifactLocation!.uri!;
			// A relative reference resolved against a base keeps the base's scheme.
			const resolved = new URL(uri, 'file:///src/');
			expect(resolved.protocol).toBe('file:');
			expect(resolved.pathname.startsWith('/src/images/')).toBe(true);
		}
	});

	test('handles empty findings', () => {
		const log = findingsToSarif([]);
		expect(log.runs[0].results).toHaveLength(0);
		expect(log.runs[0].tool.driver.rules).toHaveLength(0);
	});

	test('respects custom tool name/version', () => {
		const log = findingsToSarif([finding()], { toolName: 'CI', toolVersion: '2.0.0' });
		expect(log.runs[0].tool.driver.name).toBe('CI');
		expect(log.runs[0].tool.driver.version).toBe('2.0.0');
	});
});
