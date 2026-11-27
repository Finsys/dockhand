import { describe, expect, test } from 'bun:test';
import { replaceServiceImageTag } from '../src/lib/utils/compose-image-tag';

const compose = `services:
  web:
    image: ghcr.io/owner/app:1.2.0 # pinned
    ports:
      - "8080:80"
  db:
    image: postgres:16.1
    environment:
      image: not-this
`;

describe('replaceServiceImageTag', () => {
	test('replaces only the target service tag and keeps comments', () => {
		const result = replaceServiceImageTag(compose, 'web', 'ghcr.io/owner/app:1.2.0', '1.3.0');
		expect(result).toEqual({
			ok: true,
			image: 'ghcr.io/owner/app:1.3.0',
			content: compose.replace('app:1.2.0 # pinned', 'app:1.3.0 # pinned')
		});
	});

	test('finds the service when another service uses the same image', () => {
		const yaml = `services:\n  a:\n    image: nginx:1.25\n  b:\n    image: nginx:1.25\n`;
		const result = replaceServiceImageTag(yaml, 'b', 'nginx:1.25', '1.27');
		expect(result.ok && result.content).toBe(`services:\n  a:\n    image: nginx:1.25\n  b:\n    image: nginx:1.27\n`);
	});

	test('keeps quotes and CRLF line endings', () => {
		const yaml = 'services:\r\n  db:\r\n    image: "postgres:16.1"\r\n';
		const result = replaceServiceImageTag(yaml, 'db', 'postgres:16.1', '16.4');
		expect(result.ok && result.content).toBe('services:\r\n  db:\r\n    image: "postgres:16.4"\r\n');
	});

	test('swaps a pinned digest for the new one, or drops it when unknown', () => {
		const yaml = `services:\n  app:\n    image: nginx:1.25@sha256:old\n`;
		const withDigest = replaceServiceImageTag(yaml, 'app', 'nginx:1.25', '1.27', 'sha256:new');
		expect(withDigest.ok && withDigest.image).toBe('nginx:1.27@sha256:new');
		const withoutDigest = replaceServiceImageTag(yaml, 'app', 'nginx:1.25', '1.27');
		expect(withoutDigest.ok && withoutDigest.image).toBe('nginx:1.27');
	});

	test('does not add a digest to an unpinned image', () => {
		const result = replaceServiceImageTag(compose, 'db', 'postgres:16.1', '16.4', 'sha256:new');
		expect(result.ok && result.image).toBe('postgres:16.4');
	});

	test('matches docker.io and library prefixes', () => {
		const yaml = `services:\n  db:\n    image: docker.io/library/postgres:16.1\n`;
		const result = replaceServiceImageTag(yaml, 'db', 'postgres:16.1', '16.4');
		expect(result.ok && result.image).toBe('docker.io/library/postgres:16.4');
	});

	test('keeps a registry port', () => {
		const yaml = `services:\n  app:\n    image: registry.local:5000/app:2.0\n`;
		const result = replaceServiceImageTag(yaml, 'app', 'registry.local:5000/app:2.0', '2.1');
		expect(result.ok && result.image).toBe('registry.local:5000/app:2.1');
	});

	test('refuses a tag that comes from a variable', () => {
		const yaml = `services:\n  app:\n    image: nginx:\${NGINX_TAG}\n`;
		expect(replaceServiceImageTag(yaml, 'app', 'nginx:1.25', '1.27')).toEqual({ ok: false, reason: 'variable' });
	});

	test('reports a missing service, image or a different repo', () => {
		expect(replaceServiceImageTag(compose, 'cache', 'redis:7', '8')).toEqual({ ok: false, reason: 'service_not_found' });
		expect(replaceServiceImageTag(`services:\n  app:\n    build: .\n`, 'app', 'app:1', '2')).toEqual({ ok: false, reason: 'image_not_found' });
		expect(replaceServiceImageTag(compose, 'db', 'mysql:8.0', '8.4')).toEqual({ ok: false, reason: 'repo_mismatch' });
		expect(replaceServiceImageTag('version: "3"\n', 'app', 'app:1', '2')).toEqual({ ok: false, reason: 'service_not_found' });
	});

	test('reports a compose file that already has the new tag', () => {
		expect(replaceServiceImageTag(compose, 'db', 'postgres:16.1', '16.1')).toEqual({ ok: false, reason: 'unchanged' });
	});
});
