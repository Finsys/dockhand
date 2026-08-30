import { describe, test, expect } from 'bun:test';
import { makeLineForwarder } from '../src/lib/server/secret-redaction';

describe('line forwarding with redaction', () => {
	test('forwards lines redacted, not raw', async () => {
		const seen: string[] = [];
		const secret = 'sup3rsecret-password-42';

		// makeLineForwarder is the small bridge between collectProcess and send()
		const forward = makeLineForwarder(seen.push.bind(seen), [secret]);
		forward(`Error: password=${secret} rejected`);
		forward('Container app-1  Started');

		expect(seen).toEqual([
			'Error: password=*** rejected',
			'Container app-1  Started'
		]);
		expect(seen.join('\n')).not.toContain(secret);
	});

	test('drops a withheld line entirely', () => {
		const seen: string[] = [];
		const forward = makeLineForwarder(seen.push.bind(seen), ['test']);
		forward('Pulling alpine:latest');
		expect(seen).toEqual([]);
	});
});
