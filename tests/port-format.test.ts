import { describe, test, expect } from 'bun:test';
import { formatPorts, formatExposedPorts } from '../src/lib/utils/port-format';

describe('formatPorts', () => {
	test('returns empty array for null/undefined/empty', () => {
		expect(formatPorts(null)).toEqual([]);
		expect(formatPorts(undefined)).toEqual([]);
		expect(formatPorts([])).toEqual([]);
	});

	test('single port mapping', () => {
		const result = formatPorts([{ PublicPort: 8080, PrivatePort: 80 }]);
		expect(result).toEqual([
			{ publicPort: 8080, privatePort: 80, display: '8080:80' }
		]);
	});

	test('multiple non-consecutive ports stay separate', () => {
		const result = formatPorts([
			{ PublicPort: 8080, PrivatePort: 80 },
			{ PublicPort: 9090, PrivatePort: 90 },
			{ PublicPort: 3000, PrivatePort: 3000 }
		]);
		expect(result).toHaveLength(3);
		expect(result[0].display).toBe('3000:3000');
		expect(result[1].display).toBe('8080:80');
		expect(result[2].display).toBe('9090:90');
	});

	test('3 consecutive ports collapse into range', () => {
		const result = formatPorts([
			{ PublicPort: 8080, PrivatePort: 8080 },
			{ PublicPort: 8081, PrivatePort: 8081 },
			{ PublicPort: 8082, PrivatePort: 8082 }
		]);
		expect(result).toEqual([
			{ publicPort: 8080, privatePort: 8080, display: '8080-8082:8080-8082', isRange: true }
		]);
	});

	test('2 consecutive ports do NOT collapse', () => {
		const result = formatPorts([
			{ PublicPort: 5000, PrivatePort: 5000 },
			{ PublicPort: 5001, PrivatePort: 5001 }
		]);
		expect(result).toHaveLength(2);
		expect(result[0]).toEqual({ publicPort: 5000, privatePort: 5000, display: '5000:5000' });
		expect(result[1]).toEqual({ publicPort: 5001, privatePort: 5001, display: '5001:5001' });
	});

	test('NPM-style ports (80, 81, 443) stay as individual ports', () => {
		const result = formatPorts([
			{ PublicPort: 443, PrivatePort: 443 },
			{ PublicPort: 81, PrivatePort: 81 },
			{ PublicPort: 80, PrivatePort: 80 }
		]);
		expect(result).toHaveLength(3);
		expect(result[0].display).toBe('80:80');
		expect(result[1].display).toBe('81:81');
		expect(result[2].display).toBe('443:443');
		expect(result.every(p => !p.isRange)).toBe(true);
	});

	test('consecutive public ports with different private port offsets do not collapse', () => {
		const result = formatPorts([
			{ PublicPort: 8080, PrivatePort: 80 },
			{ PublicPort: 8081, PrivatePort: 90 }
		]);
		expect(result).toHaveLength(2);
		expect(result[0].display).toBe('8080:80');
		expect(result[1].display).toBe('8081:90');
	});

	test('mapped range with offset (public != private, 3+ ports)', () => {
		const result = formatPorts([
			{ PublicPort: 9000, PrivatePort: 8000 },
			{ PublicPort: 9001, PrivatePort: 8001 },
			{ PublicPort: 9002, PrivatePort: 8002 }
		]);
		expect(result).toEqual([
			{ publicPort: 9000, privatePort: 8000, display: '9000-9002:8000-8002', isRange: true }
		]);
	});

	test('mixed ranges and individual ports', () => {
		const result = formatPorts([
			{ PublicPort: 8080, PrivatePort: 8080 },
			{ PublicPort: 8081, PrivatePort: 8081 },
			{ PublicPort: 8082, PrivatePort: 8082 },
			{ PublicPort: 3000, PrivatePort: 3000 },
			{ PublicPort: 9090, PrivatePort: 90 }
		]);
		expect(result).toHaveLength(3);
		expect(result[0].display).toBe('3000:3000');
		expect(result[0].isRange).toBeUndefined();
		expect(result[1].display).toBe('8080-8082:8080-8082');
		expect(result[1].isRange).toBe(true);
		expect(result[2].display).toBe('9090:90');
	});

	test('two separate ranges (3+ each)', () => {
		const result = formatPorts([
			{ PublicPort: 8080, PrivatePort: 8080 },
			{ PublicPort: 8081, PrivatePort: 8081 },
			{ PublicPort: 8082, PrivatePort: 8082 },
			{ PublicPort: 9000, PrivatePort: 9000 },
			{ PublicPort: 9001, PrivatePort: 9001 },
			{ PublicPort: 9002, PrivatePort: 9002 }
		]);
		expect(result).toHaveLength(2);
		expect(result[0].display).toBe('8080-8082:8080-8082');
		expect(result[1].display).toBe('9000-9002:9000-9002');
	});

	test('deduplicates identical port mappings', () => {
		const result = formatPorts([
			{ PublicPort: 8080, PrivatePort: 80 },
			{ PublicPort: 8080, PrivatePort: 80 },
			{ PublicPort: 8080, PrivatePort: 80 }
		]);
		expect(result).toHaveLength(1);
		expect(result[0].display).toBe('8080:80');
	});

	test('filters out ports without PublicPort', () => {
		const result = formatPorts([
			{ PublicPort: 0, PrivatePort: 80 },
			{ PublicPort: 8080, PrivatePort: 80 }
		] as any);
		expect(result).toHaveLength(1);
		expect(result[0].display).toBe('8080:80');
	});

	test('unsorted input gets sorted by public port', () => {
		const result = formatPorts([
			{ PublicPort: 9000, PrivatePort: 9000 },
			{ PublicPort: 3000, PrivatePort: 3000 },
			{ PublicPort: 8080, PrivatePort: 80 }
		]);
		expect(result[0].publicPort).toBe(3000);
		expect(result[1].publicPort).toBe(8080);
		expect(result[2].publicPort).toBe(9000);
	});

	test('gap of one breaks the range', () => {
		const result = formatPorts([
			{ PublicPort: 8080, PrivatePort: 8080 },
			{ PublicPort: 8082, PrivatePort: 8082 }
		]);
		expect(result).toHaveLength(2);
		expect(result[0].display).toBe('8080:8080');
		expect(result[1].display).toBe('8082:8082');
	});
});

describe('formatPorts (camelCase input)', () => {
	test('single port mapping with camelCase keys', () => {
		const result = formatPorts([{ publicPort: 8080, privatePort: 80 }]);
		expect(result).toEqual([
			{ publicPort: 8080, privatePort: 80, display: '8080:80' }
		]);
	});

	test('3 consecutive camelCase ports collapse into range', () => {
		const result = formatPorts([
			{ publicPort: 5000, privatePort: 5000 },
			{ publicPort: 5001, privatePort: 5001 },
			{ publicPort: 5002, privatePort: 5002 }
		]);
		expect(result).toEqual([
			{ publicPort: 5000, privatePort: 5000, display: '5000-5002:5000-5002', isRange: true }
		]);
	});

	test('mixed camelCase ports and individual', () => {
		const result = formatPorts([
			{ publicPort: 5000, privatePort: 5000 },
			{ publicPort: 5001, privatePort: 5001 },
			{ publicPort: 5002, privatePort: 5002 },
			{ publicPort: 8080, privatePort: 80 }
		]);
		expect(result).toHaveLength(2);
		expect(result[0].display).toBe('5000-5002:5000-5002');
		expect(result[1].display).toBe('8080:80');
	});

	test('deduplicates camelCase ports (IPv4/IPv6 duplicates)', () => {
		const result = formatPorts([
			{ publicPort: 5000, privatePort: 5000 },
			{ publicPort: 5000, privatePort: 5000 },
			{ publicPort: 5001, privatePort: 5001 },
			{ publicPort: 5001, privatePort: 5001 },
			{ publicPort: 5002, privatePort: 5002 },
			{ publicPort: 5002, privatePort: 5002 }
		]);
		expect(result).toEqual([
			{ publicPort: 5000, privatePort: 5000, display: '5000-5002:5000-5002', isRange: true }
		]);
	});

	test('2 consecutive camelCase ports with dedup stay separate', () => {
		const result = formatPorts([
			{ publicPort: 5000, privatePort: 5000 },
			{ publicPort: 5000, privatePort: 5000 },
			{ publicPort: 5001, privatePort: 5001 },
			{ publicPort: 5001, privatePort: 5001 }
		]);
		expect(result).toHaveLength(2);
		expect(result[0].display).toBe('5000:5000');
		expect(result[1].display).toBe('5001:5001');
	});
});

describe('formatExposedPorts', () => {
	test('empty / nullish input yields no ports', () => {
		expect(formatExposedPorts([])).toEqual([]);
		expect(formatExposedPorts(null)).toEqual([]);
		expect(formatExposedPorts(undefined)).toEqual([]);
	});
	test('an EXPOSE-only port (no public mapping) is returned as exposed', () => {
		expect(formatExposedPorts([{ PrivatePort: 80 }])).toEqual([
			{ publicPort: 0, privatePort: 80, display: '80', exposed: true },
		]);
	});
	test('a published port is NOT listed as exposed', () => {
		expect(formatExposedPorts([{ PrivatePort: 80, PublicPort: 8080 }])).toEqual([]);
	});
	test('with a mix, only the truly exposed (unpublished) port is returned', () => {
		const out = formatExposedPorts([{ PrivatePort: 80, PublicPort: 8080 }, { PrivatePort: 443 }]);
		expect(out).toEqual([{ publicPort: 0, privatePort: 443, display: '443', exposed: true }]);
	});
	test('duplicate exposed ports are de-duplicated', () => {
		expect(formatExposedPorts([{ PrivatePort: 9000 }, { PrivatePort: 9000 }])).toHaveLength(1);
	});
});
