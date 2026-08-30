import { describe, test, expect } from 'bun:test';
import { makeLineForwarder } from '../src/lib/server/secret-redaction';

describe('Zeilen-Weiterleitung mit Bereinigung', () => {
	test('reicht Zeilen bereinigt weiter, nicht roh', async () => {
		const gesehen: string[] = [];
		const geheim = 'sup3rgeheim-passwort-42';

		// forwardLine ist die kleine Bruecke zwischen collectProcess und send()
		const forward = makeLineForwarder(gesehen.push.bind(gesehen), [geheim]);
		forward(`Error: password=${geheim} rejected`);
		forward('Container app-1  Started');

		expect(gesehen).toEqual([
			'Error: password=*** rejected',
			'Container app-1  Started'
		]);
		expect(gesehen.join('\n')).not.toContain(geheim);
	});

	test('unterdrueckt eine zurueckgehaltene Zeile vollstaendig', () => {
		const gesehen: string[] = [];
		const forward = makeLineForwarder(gesehen.push.bind(gesehen), ['test']);
		forward('Pulling alpine:latest');
		expect(gesehen).toEqual([]);
	});
});
