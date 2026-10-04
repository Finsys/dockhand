import { describe, test, expect } from 'bun:test';
import { containerDisplayName, DISPLAY_NAME_LABEL } from '../src/lib/utils/container-display-name';
import { DOCKHAND_LABELS } from '../src/lib/server/container-labels';

describe('containerDisplayName', () => {
	test('uses the dockhand.name label when set', () => {
		expect(containerDisplayName({ name: 'acme-grafana', labels: { 'dockhand.name': 'grafana' } })).toBe('grafana');
	});

	test('trims the label value', () => {
		expect(containerDisplayName({ name: 'acme-grafana', labels: { 'dockhand.name': '  grafana ' } })).toBe('grafana');
	});

	test('falls back to the container name when the label is missing, empty or blank', () => {
		expect(containerDisplayName({ name: 'acme-grafana' })).toBe('acme-grafana');
		expect(containerDisplayName({ name: 'acme-grafana', labels: null })).toBe('acme-grafana');
		expect(containerDisplayName({ name: 'acme-grafana', labels: {} })).toBe('acme-grafana');
		expect(containerDisplayName({ name: 'acme-grafana', labels: { 'dockhand.name': '' } })).toBe('acme-grafana');
		expect(containerDisplayName({ name: 'acme-grafana', labels: { 'dockhand.name': '   ' } })).toBe('acme-grafana');
	});

	test('does not fall back to the compose service name', () => {
		expect(containerDisplayName({ name: 'acme-grafana', labels: { 'com.docker.compose.service': 'grafana' } })).toBe('acme-grafana');
	});

	test('label key matches the registered Dockhand label', () => {
		expect(DISPLAY_NAME_LABEL).toBe(DOCKHAND_LABELS.NAME);
	});
});
