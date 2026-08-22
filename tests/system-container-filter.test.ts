/**
 * Unit tests for system container detection and filtering.
 *
 * Verifies that Dockhand and Hawser containers are correctly identified
 * and excluded from batch update operations (#485).
 *
 * Run with: bun test tests/system-container-filter.test.ts
 */

import { describe, test, expect } from 'bun:test';
import {
	isDockhandContainer,
	isHawserContainer,
	isSystemContainer,
	isPodmanInfraContainer
} from '../src/lib/server/scheduler/tasks/update-utils';

describe('isDockhandContainer', () => {
	test('matches fnsys/dockhand', () => {
		expect(isDockhandContainer('fnsys/dockhand:latest')).toBe(true);
		expect(isDockhandContainer('fnsys/dockhand:v1.0.0')).toBe(true);
		expect(isDockhandContainer('fnsys/dockhand')).toBe(true);
	});

	test('matches registry-prefixed dockhand', () => {
		expect(isDockhandContainer('registry.example.com/dockhand:abc123')).toBe(true);
		expect(isDockhandContainer('ghcr.io/finsys/dockhand:latest')).toBe(true);
	});

	test('matches plain dockhand', () => {
		expect(isDockhandContainer('dockhand:latest')).toBe(true);
		expect(isDockhandContainer('dockhand')).toBe(true);
	});

	test('is case insensitive', () => {
		expect(isDockhandContainer('Fnsys/Dockhand:Latest')).toBe(true);
		expect(isDockhandContainer('FNSYS/DOCKHAND')).toBe(true);
	});

	test('does not match unrelated images', () => {
		expect(isDockhandContainer('nginx:latest')).toBe(false);
		expect(isDockhandContainer('my-dockhand-fork:v1')).toBe(false);
	});
});

describe('isHawserContainer', () => {
	test('matches finsys/hawser', () => {
		expect(isHawserContainer('finsys/hawser:latest')).toBe(true);
		expect(isHawserContainer('finsys/hawser:v0.5.0')).toBe(true);
		expect(isHawserContainer('finsys/hawser')).toBe(true);
	});

	test('matches ghcr.io/finsys/hawser', () => {
		expect(isHawserContainer('ghcr.io/finsys/hawser:latest')).toBe(true);
		expect(isHawserContainer('ghcr.io/finsys/hawser')).toBe(true);
	});

	test('is case insensitive', () => {
		expect(isHawserContainer('Finsys/Hawser:Latest')).toBe(true);
		expect(isHawserContainer('GHCR.IO/FINSYS/HAWSER')).toBe(true);
	});

	test('does not match unrelated images', () => {
		expect(isHawserContainer('nginx:latest')).toBe(false);
		expect(isHawserContainer('hawser-custom:v1')).toBe(false);
	});
});

describe('isSystemContainer', () => {
	test('returns "dockhand" for Dockhand images', () => {
		expect(isSystemContainer('fnsys/dockhand:latest')).toBe('dockhand');
	});

	test('returns "hawser" for Hawser images', () => {
		expect(isSystemContainer('finsys/hawser:latest')).toBe('hawser');
		expect(isSystemContainer('ghcr.io/finsys/hawser:v1')).toBe('hawser');
	});

	test('returns null for regular images', () => {
		expect(isSystemContainer('nginx:latest')).toBeNull();
		expect(isSystemContainer('redis:7')).toBeNull();
		expect(isSystemContainer('postgres:16')).toBeNull();
	});
});

describe('batch update filtering (#485)', () => {
	// Simulates the check-updates response filtering
	interface CheckResult {
		containerId: string;
		containerName: string;
		imageName: string;
		hasUpdate: boolean;
		systemContainer: string | null;
	}

	const mockResults: CheckResult[] = [
		{ containerId: 'c1', containerName: 'nginx', imageName: 'nginx:latest', hasUpdate: true, systemContainer: null },
		{ containerId: 'c2', containerName: 'redis', imageName: 'redis:7', hasUpdate: true, systemContainer: null },
		{ containerId: 'c3', containerName: 'dockhand', imageName: 'fnsys/dockhand:latest', hasUpdate: true, systemContainer: 'dockhand' },
		{ containerId: 'c4', containerName: 'hawser-agent', imageName: 'ghcr.io/finsys/hawser:v0.5', hasUpdate: true, systemContainer: 'hawser' },
		{ containerId: 'c5', containerName: 'postgres', imageName: 'postgres:16', hasUpdate: false, systemContainer: null },
	];

	test('updatesFound count excludes system containers', () => {
		const updatesFound = mockResults.filter(r => r.hasUpdate && !r.systemContainer).length;
		expect(updatesFound).toBe(2); // nginx + redis only
	});

	test('containersWithUpdates excludes system containers', () => {
		const containersWithUpdates = mockResults.filter(r => r.hasUpdate && !r.systemContainer);
		expect(containersWithUpdates.map(r => r.containerName)).toEqual(['nginx', 'redis']);
	});

	test('system containers with updates are not included', () => {
		const containersWithUpdates = mockResults.filter(r => r.hasUpdate && !r.systemContainer);
		const ids = containersWithUpdates.map(r => r.containerId);
		expect(ids).not.toContain('c3'); // dockhand
		expect(ids).not.toContain('c4'); // hawser
	});
});

describe('isPodmanInfraContainer (#1221)', () => {
	test('accepts pod-id-prefixed infra (real podman 5.4.2 shape)', () => {
		expect(isPodmanInfraContainer('fb575a549efc-infra')).toBe(true);
	});

	test('accepts pod-name-prefixed infra (the #1221 reporter shape)', () => {
		expect(isPodmanInfraContainer('someapp-pod-infra')).toBe(true);
		expect(isPodmanInfraContainer('testpod-infra')).toBe(true);
	});

	test('accepts underscore separator', () => {
		expect(isPodmanInfraContainer('foo_infra')).toBe(true);
	});

	test('is case-insensitive', () => {
		expect(isPodmanInfraContainer('TESTPOD-INFRA')).toBe(true);
	});

	test('rejects user containers that merely contain "infra"', () => {
		expect(isPodmanInfraContainer('my-infrastructure')).toBe(false);
		expect(isPodmanInfraContainer('core-infra-svc')).toBe(false);
		expect(isPodmanInfraContainer('infra-monitoring')).toBe(false);
		expect(isPodmanInfraContainer('infra')).toBe(false); // no separator
	});

	test('rejects empty / undefined', () => {
		expect(isPodmanInfraContainer(undefined)).toBe(false);
		expect(isPodmanInfraContainer('')).toBe(false);
	});

	test('handles leading-slash names (Docker API returns /name)', () => {
		expect(isPodmanInfraContainer('/fb575a549efc-infra')).toBe(true);
	});
});
