import { describe, test, expect } from 'bun:test';
import { makeLineForwarder } from '../src/lib/server/secret-redaction';

describe('line forwarding with redaction', () => {
	test('forwards lines redacted, not raw', async () => {
		const gesehen: string[] = [];
		const geheim = 'sup3rgeheim-passwort-42';

		// makeLineForwarder is the small bridge between collectProcess and send()
		const forward = makeLineForwarder(gesehen.push.bind(gesehen), [geheim]);
		forward(`Error: password=${geheim} rejected`);
		forward('Container app-1  Started');

		expect(gesehen).toEqual([
			'Error: password=*** rejected',
			'Container app-1  Started'
		]);
		expect(gesehen.join('\n')).not.toContain(geheim);
	});

	test('drops a withheld line entirely', () => {
		const gesehen: string[] = [];
		const forward = makeLineForwarder(gesehen.push.bind(gesehen), ['test']);
		forward('Pulling alpine:latest');
		expect(gesehen).toEqual([]);
	});
});
