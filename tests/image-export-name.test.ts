import { describe, expect, test } from 'bun:test';
import { exportFileStem, shortId, exportRefFor } from '../src/lib/server/image-export-name';

const ID = 'sha256:9f2a4b1c3d5e7081926354a7b8c9d0e1f2a3b4c5d6e7f80912a3b4c5d6e7f809';

describe('naming an exported image', () => {
	test('after the tag that was clicked', () => {
		// The export is addressed by id, so without this an image with several tags
		// always downloads under whichever one Docker happens to list first.
		const stem = exportFileStem(ID, ['technitium/dns-server:15.5.1', 'technitium/dns-server:latest'], 'technitium/dns-server:latest');
		expect(stem).toBe('technitium_dns-server_latest');
	});

	test('after the first tag when none was asked for', () => {
		expect(exportFileStem(ID, ['nginx:latest', 'nginx:1.27'], null)).toBe('nginx_latest');
	});

	test('slashes and colons do not reach the filename', () => {
		// A registry-qualified name has both, and neither belongs in a download name.
		expect(exportFileStem(ID, ['registry.example.com/team/app:v2'], null)).toBe(
			'registry.example.com_team_app_v2'
		);
	});
});

describe('a tag the image does not carry', () => {
	test('is ignored in favour of a real one', () => {
		// The value arrives in a query parameter and ends up in a Content-Disposition
		// header, so it is checked against the image rather than trusted.
		expect(exportFileStem(ID, ['nginx:latest'], 'somebody-elses:tag')).toBe('nginx_latest');
	});

	test('cannot smuggle a path or a header break into the filename', () => {
		for (const hostile of ['../../etc/passwd', 'x"; rm -rf /', 'a\r\nContent-Length: 0']) {
			expect(exportFileStem(ID, ['nginx:latest'], hostile)).toBe('nginx_latest');
		}
	});
});

describe('an image with no tags at all', () => {
	test('falls back to the short digest, as docker shows it', () => {
		expect(exportFileStem(ID, [], null)).toBe('9f2a4b1c3d5e');
		expect(exportFileStem(ID, undefined, 'anything')).toBe('9f2a4b1c3d5e');
	});

	test('shortId drops the algorithm prefix', () => {
		expect(shortId(ID)).toBe('9f2a4b1c3d5e');
		expect(shortId('9f2a4b1c3d5e7081')).toBe('9f2a4b1c3d5e');
	});
});

describe('what the daemon is asked to export', () => {
	test('the clicked tag, so the tar keeps the name', () => {
		// A tar saved by id records RepoTags: null and loads back as an unnamed image,
		// which breaks the export/load round trip the feature exists for.
		expect(exportRefFor(ID, ['nginx:1.27', 'nginx:latest'], 'nginx:latest')).toBe('nginx:latest');
	});

	test('the first tag when none was asked for', () => {
		expect(exportRefFor(ID, ['nginx:latest', 'nginx:1.27'], null)).toBe('nginx:latest');
	});

	test('a tag the image does not carry never reaches the daemon', () => {
		expect(exportRefFor(ID, ['nginx:latest'], 'somebody-elses:tag')).toBe('nginx:latest');
		expect(exportRefFor(ID, ['nginx:latest'], '../../etc/passwd')).toBe('nginx:latest');
	});

	test('an untagged image falls back to its id', () => {
		expect(exportRefFor(ID, [], null)).toBe(ID);
		expect(exportRefFor(ID, undefined, 'anything')).toBe(ID);
	});
});
