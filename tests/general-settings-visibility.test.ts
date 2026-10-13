import { describe, expect, test } from 'bun:test';
import {
	visibleGeneralSettings,
	PRESENTATION_SETTINGS
} from '../src/lib/server/general-settings-visibility';

/**
 * Who sees what in the general settings table.
 *
 * The page renders for everybody, so the values that decide how a date or a log line
 * is drawn have to reach everybody. The rest describes how the installation is built
 * and operated, and somebody who may not view settings should not learn it by opening
 * a tab.
 */

const ALL = {
	// presentation
	timeFormat: '24h',
	dateFormat: 'DD.MM.YYYY',
	fontSize: 'normal',
	confirmDestructive: true,
	defaultTimezone: 'UTC',
	defaultComposeTemplate: 'services:\n  app:\n    image: nginx:alpine',
	// operational
	defaultGrypeArgs: '-o json -v {image}',
	defaultTrivyArgs: 'image --format json {image}',
	defaultGrypeImage: 'anchore/grype:v0.110.0',
	defaultTrivyImage: 'aquasec/trivy:0.69.3',
	defaultScannerNetworkMode: 'bridge',
	defaultScannerDns: ['10.0.0.1'],
	externalStackPaths: ['/opt/stacks', '/srv/compose'],
	primaryStackLocation: '/opt/stacks',
	scheduleCleanupCron: '0 3 * * *',
	metricsCollectionInterval: 30000,
	honorProxyLabels: true,
	protectScannerImages: true
};

describe('somebody who may view settings', () => {
	test('sees the table as it is', () => {
		expect(visibleGeneralSettings(ALL, true)).toEqual(ALL);
	});
});

describe('somebody who may not', () => {
	const visible = visibleGeneralSettings(ALL, false);

	test('keeps the compose template, which is a feature for people who author stacks', () => {
		// Authoring a stack needs no settings permission, so withholding this would
		// hand those users the built-in sample instead of their own starting point.
		expect(visible.defaultComposeTemplate).toContain('nginx:alpine');
	});

	test('still gets what the interface needs to draw itself', () => {
		expect(visible.timeFormat).toBe('24h');
		expect(visible.dateFormat).toBe('DD.MM.YYYY');
		expect(visible.fontSize).toBe('normal');
		expect(visible.confirmDestructive).toBe(true);
		expect(visible.defaultTimezone).toBe('UTC');
	});

	test('learns nothing about the security scanners', () => {
		// Their image versions say which published vulnerabilities this host still has.
		for (const key of [
			'defaultGrypeArgs',
			'defaultTrivyArgs',
			'defaultGrypeImage',
			'defaultTrivyImage'
		]) {
			expect(key in visible).toBe(false);
		}
	});

	test('learns nothing about the network those scanners run on', () => {
		expect('defaultScannerNetworkMode' in visible).toBe(false);
		expect('defaultScannerDns' in visible).toBe(false);
		expect('honorProxyLabels' in visible).toBe(false);
	});

	test('learns nothing about the filesystem layout of the host', () => {
		expect('externalStackPaths' in visible).toBe(false);
		expect('primaryStackLocation' in visible).toBe(false);
	});

	test('learns nothing about how the installation is scheduled', () => {
		expect('scheduleCleanupCron' in visible).toBe(false);
		expect('metricsCollectionInterval' in visible).toBe(false);
	});

	test('hidden settings are absent, not blanked', () => {
		// A key present with a null value would still say the setting exists and
		// distinguish "hidden" from "never configured".
		expect(Object.values(visible)).not.toContain(null);
		expect(Object.keys(visible).length).toBeLessThan(Object.keys(ALL).length);
	});
});

describe('a setting nobody has classified yet', () => {
	test('is private until somebody decides otherwise', () => {
		// The allow-list is what makes this the default, and being wrong in this
		// direction only costs a setting the UI has to ask for again.
		const withNewKey = { ...ALL, someSettingAddedLater: 'secret-ish' };
		expect('someSettingAddedLater' in visibleGeneralSettings(withNewKey, false)).toBe(false);
	});

	test('the allow-list holds no operational key by accident', () => {
		const operational = /grype|trivy|scanner|cron|interval|retention|path|proxy|stackLocation/i;
		const slipped = PRESENTATION_SETTINGS.filter((k) => operational.test(k));
		expect(slipped).toEqual([]);
	});
});
