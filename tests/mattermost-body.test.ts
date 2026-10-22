import { describe, test, expect } from 'bun:test';
import { buildMattermostBody } from '../src/lib/server/notifications/mattermost';

const TS = 1_700_000_000;

describe('buildMattermostBody', () => {
	test('sends a colour-coded attachment rather than plain text', () => {
		const body = buildMattermostBody(
			{ title: 'Container started', message: 'nginx is up', type: 'success' },
			undefined,
			TS
		);
		expect(body.text).toBeUndefined(); // both would render, showing the message twice
		expect(body.attachments).toEqual([
			{
				color: '#00FF00',
				fallback: 'Container started\nnginx is up',
				title: 'Container started',
				text: 'nginx is up',
				mrkdwn_in: ['text', 'pretext'],
				ts: TS
			}
		]);
	});

	test('each severity gets its own colour, matching the Discord embed', () => {
		const colorFor = (type: 'error' | 'warning' | 'success' | 'info') =>
			(buildMattermostBody({ title: 't', message: 'm', type }, undefined, TS).attachments as any[])[0]
				.color;
		expect(colorFor('error')).toBe('#FF0000');
		expect(colorFor('warning')).toBe('#FFAA00');
		expect(colorFor('success')).toBe('#00FF00');
		expect(colorFor('info')).toBe('#0099FF');
	});

	test('an absent or unknown type falls back to info rather than dropping the colour', () => {
		const noType = buildMattermostBody({ title: 't', message: 'm' }, undefined, TS);
		expect((noType.attachments as any[])[0].color).toBe('#0099FF');
		const odd = buildMattermostBody({ title: 't', message: 'm', type: 'bogus' as never }, undefined, TS);
		expect((odd.attachments as any[])[0].color).toBe('#0099FF');
	});

	test('the environment appears in the title and the footer', () => {
		const attachment = (
			buildMattermostBody(
				{ title: 'Stack deployed', message: 'ok', type: 'info', environmentName: 'prod' },
				undefined,
				TS
			).attachments as any[]
		)[0];
		expect(attachment.title).toBe('Stack deployed [prod]');
		expect(attachment.footer).toBe('Environment: prod');
	});

	test('without an environment there is no footer key at all', () => {
		const attachment = (
			buildMattermostBody({ title: 'Stack deployed', message: 'ok' }, undefined, TS)
				.attachments as any[]
		)[0];
		expect(attachment.title).toBe('Stack deployed');
		expect('footer' in attachment).toBe(false);
	});

	test('the fallback carries the message, since push and email read that and not the card', () => {
		const attachment = (
			buildMattermostBody(
				{ title: 'Container exited', message: 'nginx exited with code 137', type: 'error' },
				undefined,
				TS
			).attachments as any[]
		)[0];
		expect(attachment.fallback).toContain('Container exited');
		expect(attachment.fallback).toContain('nginx exited with code 137');
	});

	test('the fallback names the environment too, so a push says which host', () => {
		const attachment = (
			buildMattermostBody(
				{ title: 'Stack deployed', message: 'ok', environmentName: 'prod' },
				undefined,
				TS
			).attachments as any[]
		)[0];
		expect(attachment.fallback).toBe('Stack deployed [prod]\nok');
	});

	test('the bot name is sent only when the url carries one', () => {
		expect(buildMattermostBody({ title: 't', message: 'm' }, 'dockhand', TS).username).toBe(
			'dockhand'
		);
		expect('username' in buildMattermostBody({ title: 't', message: 'm' }, undefined, TS)).toBe(
			false
		);
	});

	test('the message is carried verbatim, so markdown survives to the client', () => {
		const message = '**bold** and `code` and\na second line';
		const attachment = (
			buildMattermostBody({ title: 't', message }, undefined, TS).attachments as any[]
		)[0];
		expect(attachment.text).toBe(message);
		expect(attachment.mrkdwn_in).toEqual(['text', 'pretext']);
	});

	test('the timestamp defaults to now in seconds, not milliseconds', () => {
		const ts = (buildMattermostBody({ title: 't', message: 'm' }).attachments as any[])[0].ts;
		const nowSeconds = Math.floor(Date.now() / 1000);
		expect(Math.abs(ts - nowSeconds)).toBeLessThanOrEqual(2);
	});

	test('the result serialises to JSON the webhook accepts', () => {
		const body = buildMattermostBody(
			{ title: 'T', message: 'M', type: 'error', environmentName: 'prod' },
			'bot',
			TS
		);
		const parsed = JSON.parse(JSON.stringify(body));
		expect(parsed.username).toBe('bot');
		expect(parsed.attachments[0].color).toBe('#FF0000');
		expect(parsed.attachments[0].footer).toBe('Environment: prod');
	});
});
