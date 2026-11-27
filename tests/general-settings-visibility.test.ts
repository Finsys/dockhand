import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
	visibleGeneralSettings,
	PRESENTATION_SETTINGS,
	ADMIN_ONLY_WRITE_SETTINGS,
	writesAdminOnlySetting
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

// The scanner and backup helper containers run with a Docker socket bound in, for every
// environment, so their settings are admin-only to WRITE. An env-scoped settings:edit
// role passes can('settings','edit') without an environmentId, so the key list decides.
describe('admin-only general settings writes', () => {
	test('each helper-container key needs an administrator', () => {
		for (const key of ADMIN_ONLY_WRITE_SETTINGS) {
			expect(writesAdminOnlySetting({ [key]: 'x' })).toBe(true);
		}
	});

	test('presentation keys and the recent stack locations stay writable with settings:edit', () => {
		expect(writesAdminOnlySetting({ timeFormat: '24h', lightTheme: 'x' })).toBe(false);
		expect(writesAdminOnlySetting({ externalStackPaths: ['/srv/stacks'] })).toBe(false);
		expect(writesAdminOnlySetting({})).toBe(false);
	});

	test('clearing a key is a write too', () => {
		expect(writesAdminOnlySetting({ defaultTrivyArgs: '' })).toBe(true);
		expect(writesAdminOnlySetting({ defaultScannerDns: null })).toBe(true);
	});

	test('a key mixed into an otherwise harmless body still counts', () => {
		expect(writesAdminOnlySetting({ timeFormat: '24h', defaultBackupImage: 'evil/helper' })).toBe(true);
	});

	test('every image, default-args and scanner key the route writes is on the list', () => {
		const src = readFileSync('src/routes/api/settings/general/+server.ts', 'utf8');
		const destructured = src.match(/const \{ (confirmDestructive[^}]+)\} = body;/)![1].split(',').map((k) => k.trim());
		const helperKeys = destructured.filter((k) => /Image$|^default(Grype|Trivy)Args$|^defaultScanner/.test(k));
		expect(helperKeys.length).toBeGreaterThanOrEqual(7);
		expect(helperKeys.filter((k) => !(ADMIN_ONLY_WRITE_SETTINGS as readonly string[]).includes(k))).toEqual([]);
	});
});
