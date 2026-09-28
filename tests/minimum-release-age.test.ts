import { describe, expect, test } from 'bun:test';
import { composeReleaseAgeDecision, hawserSupportsPullPolicy, missingImageCooldownError, parseMinimumReleaseAgeHours, releaseAgeRemainingMs, resolveMinimumReleaseAgeConfig, verifiedImagePullPlan } from '../src/lib/server/minimum-release-age-core';

describe('minimum release age', () => {
	test('accepts only bounded whole hours', () => {
		expect(parseMinimumReleaseAgeHours(72)).toBe(72);
		expect(parseMinimumReleaseAgeHours('0')).toBe(0);
		expect(parseMinimumReleaseAgeHours(721)).toBeNull();
		expect(parseMinimumReleaseAgeHours(-1)).toBeNull();
		expect(parseMinimumReleaseAgeHours(1.5)).toBeNull();
		expect(parseMinimumReleaseAgeHours('')).toBeNull();
	});

	test('uses environment override, then global setting, then default', () => {
		expect(resolveMinimumReleaseAgeConfig(undefined, 72, null)).toEqual({ hours: 72, overridden: false, inherited: true });
		expect(resolveMinimumReleaseAgeConfig(undefined, 72, 0)).toEqual({ hours: 0, overridden: false, inherited: false });
		expect(resolveMinimumReleaseAgeConfig(undefined, null, null)).toEqual({ hours: 0, overridden: false, inherited: true });
	});

	test('environment variable takes precedence over both settings', () => {
		expect(resolveMinimumReleaseAgeConfig('24', 72, 48)).toEqual({ hours: 24, overridden: true, inherited: true });
		expect(() => resolveMinimumReleaseAgeConfig('invalid', 72, 48)).toThrow();
	});

	test('holds a digest until the full configured time has elapsed', () => {
		const observed = '2026-09-28T00:00:00.000Z';
		const start = Date.parse(observed);
		expect(releaseAgeRemainingMs(observed, 72, start)).toBe(72 * 3600000);
		expect(releaseAgeRemainingMs(observed, 72, start + 72 * 3600000 - 1)).toBe(1);
		expect(releaseAgeRemainingMs(observed, 72, start + 72 * 3600000)).toBe(0);
	});

	test('invalid timestamps cannot make an image immediately eligible', () => {
		expect(releaseAgeRemainingMs('invalid', 24)).toBe(24 * 3600000);
	});

	test('explains missing Compose images while cooldown blocks automatic pulls', () => {
		expect(missingImageCooldownError('Error response from daemon: No such image: registry.example.com:5000/team/app:latest'))
			.toBe('Image registry.example.com:5000/team/app:latest is not present in this environment. Minimum image release age prevents Compose from pulling it automatically. Pull this exact image through Dockhand once its cooldown has elapsed, then deploy again.');
		expect(missingImageCooldownError('other failure')).toBeNull();
	});

	test('Compose keeps builds available but blocks unverified service-image pulls', () => {
		expect(composeReleaseAgeDecision('build', 24)).toEqual({ blockPull: false, pullPolicy: undefined });
		expect(composeReleaseAgeDecision('up', 24, 'always')).toEqual({ blockPull: false, pullPolicy: 'never' });
		expect(composeReleaseAgeDecision('pull', 24)).toEqual({ blockPull: true, pullPolicy: undefined });
		expect(composeReleaseAgeDecision('pull', 0)).toEqual({ blockPull: false, pullPolicy: undefined });
	});

	test('pulls the verified digest and restores the requested local tag', () => {
		const digest = 'sha256:' + 'a'.repeat(64);
		expect(verifiedImagePullPlan('nginx:1.27', digest)).toEqual({
			reference: 'nginx@' + digest,
			tag: { repo: 'nginx', tag: '1.27' }
		});
		expect(verifiedImagePullPlan('registry.example.com:5000/team/app', digest)).toEqual({
			reference: 'registry.example.com:5000/team/app@' + digest,
			tag: { repo: 'registry.example.com:5000/team/app', tag: 'latest' }
		});
		expect(verifiedImagePullPlan('nginx@' + digest, digest)).toEqual({
			reference: 'nginx@' + digest,
			tag: null
		});
		expect(() => verifiedImagePullPlan('nginx@sha256:' + 'b'.repeat(64), digest)).toThrow('does not match');
		expect(() => verifiedImagePullPlan('nginx:latest', 'invalid')).toThrow('invalid image digest');
	});

	test('requires Hawser support for Compose pull never', () => {
		expect(hawserSupportsPullPolicy('v0.2.37')).toBe(false);
		expect(hawserSupportsPullPolicy('v0.2.38')).toBe(true);
		expect(hawserSupportsPullPolicy('0.3.0')).toBe(true);
		expect(hawserSupportsPullPolicy('dev')).toBe(false);
		expect(hawserSupportsPullPolicy(null)).toBe(false);
	});
});
