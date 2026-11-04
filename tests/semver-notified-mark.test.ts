import { describe, expect, it } from 'bun:test';
import { isBeyondNotified, notifiedMarkFor } from '../src/lib/server/semver/notified-mark';
import type { NewerVersion } from '../src/lib/server/semver/find-newer';

const REPO = 'docker.io/acme/app';
const nv = (tag: string, extra: Partial<NewerVersion> = {}): NewerVersion => ({ tag, bump: 'minor', skipped: [tag], ...extra });

describe('isBeyondNotified', () => {
	it('notifies the first suggestion', () => {
		expect(isBeyondNotified(nv('1.6.0'), REPO, undefined)).toBe(true);
	});

	it('does not notify the suggestion already notified', () => {
		expect(isBeyondNotified(nv('1.6.0'), REPO, notifiedMarkFor(nv('1.6.0'), REPO))).toBe(false);
	});

	it('does not notify another tag of the image already notified', () => {
		const mark = notifiedMarkFor(nv('1.6', { imageId: 'sha256:a', digest: 'sha256:x' }), REPO);
		expect(isBeyondNotified(nv('1.6.0', { imageId: 'sha256:a', digest: 'sha256:y' }), REPO, mark)).toBe(false);
		expect(isBeyondNotified(nv('1.6.0', { digest: 'sha256:x' }), REPO, mark)).toBe(false);
	});

	it('does not notify a suggestion wandering back among the pending betas', () => {
		// Notified b6; the next runs show b4, b2, b3: none of them is news.
		const mark = notifiedMarkFor(nv('1.6.0-b6', { createdAt: '2026-10-06T00:00:00Z' }), REPO);
		for (const [tag, at] of [['1.6.0-b4', '2026-10-04T00:00:00Z'], ['1.6.0-b2', '2026-10-02T00:00:00Z']]) {
			expect(isBeyondNotified(nv(tag, { createdAt: at }), REPO, mark)).toBe(false);
		}
		expect(isBeyondNotified(nv('1.6.0-b3'), REPO, mark)).toBe(false);
	});

	it('notifies a later build, whatever its name', () => {
		const mark = notifiedMarkFor(nv('1.6.0-b6', { createdAt: '2026-10-06T00:00:00Z' }), REPO);
		expect(isBeyondNotified(nv('1.6.0-b7', { createdAt: '2026-10-07T00:00:00Z' }), REPO, mark)).toBe(true);
	});

	it('compares versions when a date is missing', () => {
		const mark = notifiedMarkFor(nv('1.6.0'), REPO);
		expect(isBeyondNotified(nv('1.7.0', { createdAt: '2026-10-07T00:00:00Z' }), REPO, mark)).toBe(true);
		expect(isBeyondNotified(nv('1.5.9'), REPO, mark)).toBe(false);
	});

	it('starts afresh when the container moved to another image', () => {
		const mark = notifiedMarkFor(nv('1.6.0'), 'docker.io/acme/other');
		expect(isBeyondNotified(nv('1.6.0'), REPO, mark)).toBe(true);
	});
});
