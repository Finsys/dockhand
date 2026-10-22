import { describe, test, expect } from 'bun:test';
import { scannersInLog } from '../src/lib/utils/scan-log-scanners';

const entry = (...ids: string[]) => ({ scanners: ids.map((scanner) => ({ scanner })) });

describe('scannersInLog', () => {
	test('empty log has no scanner columns', () => {
		expect(scannersInLog([])).toEqual([]);
	});

	test('grype-only env shows only grype', () => {
		expect(scannersInLog([entry('grype'), entry('grype')]).map((s) => s.id)).toEqual(['grype']);
	});

	test('trivy-only env shows only trivy', () => {
		expect(scannersInLog([entry('trivy')]).map((s) => s.id)).toEqual(['trivy']);
	});

	test('both scanners keep fixed order regardless of arrival order', () => {
		expect(scannersInLog([entry('trivy'), entry('grype')]).map((s) => s.id)).toEqual(['grype', 'trivy']);
	});

	test('failed entries with no scanners and unknown ids are ignored', () => {
		expect(scannersInLog([entry(), entry('grype', 'other')]).map((s) => s.id)).toEqual(['grype']);
	});
});
