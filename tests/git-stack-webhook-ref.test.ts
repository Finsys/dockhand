import { describe, it, expect } from 'bun:test';

// Pure logic mirror to verify branch filter behavior against various push payloads.
function shouldSkipPushWebhook(payloadText: string, trackedBranch: string | null | undefined): { skip: boolean; reason?: string } {
	if (!trackedBranch || !payloadText.trim().startsWith('{')) {
		return { skip: false };
	}
	try {
		const body = JSON.parse(payloadText);
		if (typeof body?.ref === 'string' && body.ref) {
			const pushRef = body.ref;
			const expectedRef = `refs/heads/${trackedBranch}`;
			if (pushRef !== expectedRef && pushRef !== trackedBranch) {
				return {
					skip: true,
					reason: `Push was to ${pushRef}, not tracked branch ${trackedBranch}`
				};
			}
		}
	} catch {
		return { skip: false };
	}
	return { skip: false };
}

describe('git stack webhook push ref matching', () => {
	it('skips pushes to feature branches when stack tracks main', () => {
		const payload = JSON.stringify({ ref: 'refs/heads/renovate/major', repository: { name: 'app' } });
		const res = shouldSkipPushWebhook(payload, 'main');
		expect(res.skip).toBe(true);
		expect(res.reason).toBe('Push was to refs/heads/renovate/major, not tracked branch main');
	});

	it('accepts pushes matching refs/heads/<trackedBranch>', () => {
		const payload = JSON.stringify({ ref: 'refs/heads/main', repository: { name: 'app' } });
		const res = shouldSkipPushWebhook(payload, 'main');
		expect(res.skip).toBe(false);
	});

	it('accepts pushes matching plain branch name if ref format is unqualified', () => {
		const payload = JSON.stringify({ ref: 'main', repository: { name: 'app' } });
		const res = shouldSkipPushWebhook(payload, 'main');
		expect(res.skip).toBe(false);
	});

	it('does not skip payloads without ref (e.g. tag/release/manual triggers)', () => {
		const payload = JSON.stringify({ action: 'published', release: { tag_name: 'v1.0.0' } });
		const res = shouldSkipPushWebhook(payload, 'main');
		expect(res.skip).toBe(false);
	});

	it('does not skip when stack has no tracked branch defined', () => {
		const payload = JSON.stringify({ ref: 'refs/heads/feature', repository: { name: 'app' } });
		const res = shouldSkipPushWebhook(payload, null);
		expect(res.skip).toBe(false);
	});

	it('does not crash or skip on non-json text payload', () => {
		const payload = 'not-json-content';
		const res = shouldSkipPushWebhook(payload, 'main');
		expect(res.skip).toBe(false);
	});
});
