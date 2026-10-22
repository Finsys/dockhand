import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { imageCheckPlan, resolvePinnedToDigest, imagePinning, imageReferenceWithoutDigest, isDigestBasedImage } from '../src/lib/utils/tracked-image';

/**
 * `repo@sha256:...` and `repo:tag@sha256:...` read alike and mean opposite things.
 *
 * The first names one manifest and no tag, so nothing moves and there is nothing to check.
 * The second names a TAG and records which manifest was behind it - what a base image
 * patched for a CVE looks like, and what a rolling tag like `:1` or `:1.2` looks like. The
 * tag stays put while the digest moves, so the tag has to be checked or the move is never
 * reported.
 */
describe('how an image reference pins what it runs', () => {
	test('a digest with no tag pins one manifest', () => {
		expect(imagePinning('mariadb@sha256:856f')).toBe('digest');
		expect(imagePinning('ghcr.io/owner/repo@sha256:ef')).toBe('digest');
		expect(imagePinning('docker.io/library/nginx@sha256:ab')).toBe('digest');
	});

	test('a tag with a digest follows the tag', () => {
		expect(imagePinning('mariadb:13.0.2-ubi@sha256:856f')).toBe('tag-with-digest');
		expect(imagePinning('docker.io/library/nginx:latest@sha256:cd')).toBe('tag-with-digest');
	});

	test('a rolling tag is a tag with a digest, however short it is', () => {
		// A project publishing 1.2.3 also moves :1, :1.2 and :1.2.3 to it, and a compose
		// file records the digest each resolved to.
		expect(imagePinning('app:1@sha256:ab')).toBe('tag-with-digest');
		expect(imagePinning('app:1.2@sha256:ab')).toBe('tag-with-digest');
		expect(imagePinning('traefik:v3@sha256:cd')).toBe('tag-with-digest');
	});

	test('a registry port is not a tag', () => {
		// `registry:5000/app` carries a colon before the last slash, which is the port.
		expect(imagePinning('registry:5000/app@sha256:ab')).toBe('digest');
		expect(imagePinning('registry:5000/app:v1@sha256:ab')).toBe('tag-with-digest');
		expect(imagePinning('registry:5000/app:v1')).toBe('tag');
	});

	test('no digest at all is just a tag', () => {
		expect(imagePinning('mariadb:13.0.2-ubi')).toBe('tag');
		expect(imagePinning('mariadb')).toBe('tag');
		expect(imagePinning('registry:5000/app')).toBe('tag');
	});

	test('the tag half is what an update check asks the registry about', () => {
		expect(imageReferenceWithoutDigest('mariadb:13.0.2-ubi@sha256:856f')).toBe('mariadb:13.0.2-ubi');
		expect(imageReferenceWithoutDigest('registry:5000/app:v1@sha256:ab')).toBe('registry:5000/app:v1');
		expect(imageReferenceWithoutDigest('app:1@sha256:ab')).toBe('app:1');
		// Asking about the pinned reference itself would return the digest already running.
		expect(imageReferenceWithoutDigest('mariadb:13.0.2-ubi')).toBe('mariadb:13.0.2-ubi');
	});
});

/**
 * The guarantee the check makes to a user who pinned a digest on purpose.
 *
 * Reporting the move is useful - that is the whole point of a base image getting patched.
 * Applying it is not ours to do: pulling `repo:tag@sha256:...` returns the pinned manifest,
 * so an update would mean following the tag instead and rewriting the digest the user wrote
 * in their compose. `pinnedToDigest` is what carries that distinction to the caller.
 */
describe('a moved digest is reported, not applied', () => {
	const source = readFileSync(new URL('../src/lib/server/docker.ts', import.meta.url), 'utf8');

	test('the check asks the registry about the TAG, and says the answer is pinned', () => {
		// Asking about `repo:tag@sha256:...` itself returns the digest already running, so
		// the move would never be seen. The plan sends the tag half and flags the answer so
		// the caller can report the move without applying it.
		expect(imageCheckPlan('mariadb:13.0.2-ubi@sha256:856f')).toEqual({
			skip: false, reference: 'mariadb:13.0.2-ubi', pinned: true
		});
	});

	test('a digest with no tag is skipped outright', () => {
		expect(imageCheckPlan('mariadb@sha256:856f').skip).toBe(true);
		expect(imageCheckPlan('registry:5000/app@sha256:ab').skip).toBe(true);
	});

	test('a plain tag is checked and is NOT flagged as pinned', () => {
		// The near miss for the flag: an ordinary update must stay applicable, or the
		// feature would withhold every update rather than only the pinned ones.
		expect(imageCheckPlan('nginx:latest')).toEqual({
			skip: false, reference: 'nginx:latest', pinned: false
		});
	});

	test('a pinned tag is reported pinned ONLY when its digest actually moved', () => {
		// The flag means "a newer digest exists but the compose pins the old one", so it
		// must depend on hasUpdate. A pinned tag that has not moved is just up to date and
		// carries no flag - otherwise the pin marker and the update counters fire on every
		// quiet pin, and the manual and scheduled checks disagree.
		const pinned = imageCheckPlan('mariadb:13.0.2-ubi@sha256:856f');
		expect(resolvePinnedToDigest(pinned, true)).toBe(true);
		expect(resolvePinnedToDigest(pinned, false)).toBe(false);
		expect(resolvePinnedToDigest(pinned, undefined)).toBe(false);

		// A plain tag is never pinned, whatever hasUpdate says.
		const plain = imageCheckPlan('nginx:latest');
		expect(resolvePinnedToDigest(plain, true)).toBe(false);
	});

	test('the check consults the plan rather than deciding for itself', () => {
		// Behaviour above, wiring here: the pure plan protects nothing if the check
		// recomputes the reference or drops the flag.
		expect(source).toContain('const plan = imageCheckPlan(imageName)');
		expect(source).toContain('checkTagForUpdate(plan.reference');
		expect(source).toContain('resolvePinnedToDigest(plan, result.hasUpdate)');
	});

	test('the predicate the updaters gate on answers true for a pinned tag', () => {
		// This is the invariant, not the spelling of the call: detection learned to follow
		// the tag, applying did not, and what keeps the two apart is that this predicate
		// still claims every digest-bearing reference. Narrowing it to `digest` would send
		// `repo:tag@sha256:...` into the pull-and-recreate path and rewrite a digest the
		// user pinned on purpose.
		expect(isDigestBasedImage('mariadb:13.0.2-ubi@sha256:856f')).toBe(true);
		expect(isDigestBasedImage('registry:5000/app:v1@sha256:ab')).toBe(true);
		expect(isDigestBasedImage('mariadb@sha256:856f')).toBe(true);
		// A plain tag is the one shape they may act on.
		expect(isDigestBasedImage('mariadb:13.0.2-ubi')).toBe(false);
		expect(isDigestBasedImage('registry:5000/app')).toBe(false);
	});

	test('the two containers that skip outright gate on it before pulling', () => {
		// Behaviour above, wiring here: the predicate only protects anything if the
		// applying paths actually consult it.
		for (const path of [
			'../src/lib/server/scheduler/tasks/container-update.ts',
			'../src/routes/api/containers/batch-update-stream/+server.ts'
		]) {
			const updater = readFileSync(new URL(path, import.meta.url), 'utf8');
			expect(updater).toMatch(/if \(isDigestBasedImage\(\w+\)\) \{/);
		}
	});

	test('the scheduled env check drops a pinned move before building its apply list', () => {
		// This path has no digest gate of its own: its isDigestBasedImage call picks the
		// PULL STRATEGY (safe-pull vs simple pull) and BOTH branches fall through to
		// recreateContainer. So the only thing keeping a pinned container out of a
		// scheduled recreate is clearing hasUpdate BEFORE the push into updatesAvailable.
		const cron = readFileSync(
			new URL('../src/lib/server/scheduler/tasks/env-update-check.ts', import.meta.url), 'utf8');
		const suppress = cron.indexOf('result.hasUpdate && result.pinnedToDigest');
		const push = cron.indexOf('updatesAvailable.push(');
		expect(suppress).toBeGreaterThan(-1);
		expect(push).toBeGreaterThan(-1);
		expect(suppress).toBeLessThan(push);
		// And it must actually clear the flag, not merely log about it.
		expect(cron.slice(suppress, suppress + 320)).toContain('result.hasUpdate = false');
	});
});

/**
 * How the check's answer reaches the screen.
 *
 * The move is worth reporting - a base image patched for a CVE is exactly what a user
 * wants to know about - but it is not something a button here can apply. So it is counted
 * and shown apart from the updates that CAN be applied, and never joins the set a bulk
 * update acts on.
 */
/**
 * The client wiring, pinned by SOURCE TEXT only.
 *
 * A `.svelte` component cannot be imported under bun, so these assert that the wiring is
 * SPELLED, not that it behaves: a change keeping the text while discarding the value at
 * runtime would survive them. They are a tripwire against the flag being dropped
 * wholesale, and the rendering itself is verified in the browser - the same coverage the
 * sibling cooldown and newer-version indicators have.
 */
describe('a pinned image is reported apart from an applicable update', () => {
	const checkButton = readFileSync(
		new URL('../src/lib/components/CheckUpdatesButton.svelte', import.meta.url), 'utf8');
	const api = readFileSync(
		new URL('../src/routes/api/containers/check-updates/+server.ts', import.meta.url), 'utf8');

	test('the flag survives the trip from the check to the client', () => {
		expect(api).toContain('pinnedToDigest: result.pinnedToDigest');
	});

	test('it is kept out of the set a bulk update acts on', () => {
		// withUpdates is what the update modal is handed, so a pinned image joining it
		// would offer a button whose pull returns the manifest already running.
		const line = checkButton.split('\n').find((l) => l.includes('const withUpdates'));
		const filter = checkButton.slice(checkButton.indexOf('const withUpdates'));
		expect(line).toBeTruthy();
		expect(filter.slice(0, 300)).toContain('!r.pinnedToDigest');
	});

	test('it still counts as a result, so a check does not report "all up to date"', () => {
		expect(checkButton).toContain("withUpdates.length === 0 && newerVersions.length === 0 && pinned.length === 0");
	});
});
