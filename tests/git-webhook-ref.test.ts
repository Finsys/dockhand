import { describe, test, expect } from 'bun:test';
import { decideWebhookRefSkip } from '../src/lib/server/git-webhook-ref';

/** Build a GitHub-style push payload body with the given ref. */
function pushPayload(ref: string): string {
	return JSON.stringify({ ref, repository: { name: 'app' }, after: 'abc123' });
}

describe('decideWebhookRefSkip', () => {
	test('skips a push to a feature branch when the stack tracks main', () => {
		const d = decideWebhookRefSkip(pushPayload('refs/heads/renovate/major'), 'main');
		expect(d.skip).toBe(true);
		if (d.skip) {
			expect(d.ref).toBe('refs/heads/renovate/major');
			expect(d.trackedBranch).toBe('main');
		}
	});

	test('proceeds on a push to refs/heads/<trackedBranch>', () => {
		expect(decideWebhookRefSkip(pushPayload('refs/heads/main'), 'main').skip).toBe(false);
	});

	test('proceeds on a push whose ref is the bare branch name (unqualified)', () => {
		expect(decideWebhookRefSkip(pushPayload('main'), 'main').skip).toBe(false);
	});

	test('tracks a non-default branch: main is skipped, the tracked branch proceeds', () => {
		expect(decideWebhookRefSkip(pushPayload('refs/heads/main'), 'develop').skip).toBe(true);
		expect(decideWebhookRefSkip(pushPayload('refs/heads/develop'), 'develop').skip).toBe(false);
	});

	test('a branch whose name is a prefix of the tracked branch is still skipped', () => {
		// "main" must not match "main-2"; exact comparison, not startsWith.
		expect(decideWebhookRefSkip(pushPayload('refs/heads/main'), 'main-2').skip).toBe(true);
		expect(decideWebhookRefSkip(pushPayload('refs/heads/main-2'), 'main').skip).toBe(true);
	});

	test('does not skip a payload with no ref (release/ping/manual trigger)', () => {
		const body = JSON.stringify({ action: 'published', release: { tag_name: 'v1.0.0' } });
		expect(decideWebhookRefSkip(body, 'main').skip).toBe(false);
	});

	test('does not skip a tag push (refs/tags/*): branch filter only, no silent tag regression', () => {
		// A stack tracking main still deploys on a tag push, as the old handler did.
		expect(decideWebhookRefSkip(pushPayload('refs/tags/v1.0.0'), 'main').skip).toBe(false);
		// And a stack whose branch value happens to equal a tag name is not skipped on its
		// tag push either (the tag ref falls through before the branch comparison).
		expect(decideWebhookRefSkip(pushPayload('refs/tags/v1.0.0'), 'v1.0.0').skip).toBe(false);
	});

	test('does not skip when the ref is a non-string (malformed push)', () => {
		expect(decideWebhookRefSkip(JSON.stringify({ ref: 123 }), 'main').skip).toBe(false);
		expect(decideWebhookRefSkip(JSON.stringify({ ref: '' }), 'main').skip).toBe(false);
	});

	test('does not skip when the stack has no tracked branch', () => {
		expect(decideWebhookRefSkip(pushPayload('refs/heads/feature'), null).skip).toBe(false);
		expect(decideWebhookRefSkip(pushPayload('refs/heads/feature'), undefined).skip).toBe(false);
		expect(decideWebhookRefSkip(pushPayload('refs/heads/feature'), '').skip).toBe(false);
	});

	test('does not skip (or crash) on a non-JSON body', () => {
		expect(decideWebhookRefSkip('not-json', 'main').skip).toBe(false);
		expect(decideWebhookRefSkip('', 'main').skip).toBe(false);
		expect(decideWebhookRefSkip('   ', 'main').skip).toBe(false);
	});

	test('does not skip on malformed JSON that starts like an object', () => {
		expect(decideWebhookRefSkip('{ ref: broken', 'main').skip).toBe(false);
	});
});
