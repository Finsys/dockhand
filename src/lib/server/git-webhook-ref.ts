/**
 * Decide whether a git-stack webhook delivery should be skipped because the push it
 * carries is not for the branch the stack tracks. Pure so it is unit-testable without a
 * database or a live request, and import-light (no db/sqlite).
 *
 * A repository webhook delivers a push event for EVERY branch, so a stack that follows
 * `main` would otherwise re-sync on every feature or bot (Renovate) branch push. Reading
 * the ref from the already-verified payload lets the handler drop those at the source.
 *
 * Only a push payload (one carrying a string `ref`) is ever skipped. A delivery with no
 * ref - a manual trigger, a tag or release event, or a non-JSON body - always falls
 * through to the normal deploy, so no existing trigger changes behaviour.
 */

export type WebhookRefDecision =
	| { skip: false }
	| { skip: true; ref: string; trackedBranch: string };

/**
 * `trackedBranch` is the stack's effective branch (its per-stack override, else the
 * repository's branch). `payloadText` is the raw verified body.
 */
export function decideWebhookRefSkip(
	payloadText: string,
	trackedBranch: string | null | undefined
): WebhookRefDecision {
	// No tracked branch to compare against, or a body that is plainly not a JSON object:
	// nothing to decide, so proceed as before.
	if (!trackedBranch || !payloadText.trim().startsWith('{')) {
		return { skip: false };
	}

	let ref: unknown;
	try {
		ref = JSON.parse(payloadText)?.ref;
	} catch {
		// Malformed JSON: do not guess, deploy as before.
		return { skip: false };
	}

	// No string ref means this is not a push event (release, ping, manual): proceed.
	if (typeof ref !== 'string' || ref === '') {
		return { skip: false };
	}

	// Only branch pushes are filtered. A tag push (refs/tags/<name>) falls through and
	// deploys as before: the stack UI tracks a branch, not a tag, so we do not understand
	// a tag ref well enough to skip it, and dropping one would be a silent regression for
	// anyone who deploys on a tag push.
	if (ref.startsWith('refs/tags/')) {
		return { skip: false };
	}

	// GitHub sends `refs/heads/<branch>`; GitLab's push hook does too, but accept the bare
	// branch as well so an unqualified ref still matches.
	if (ref === `refs/heads/${trackedBranch}` || ref === trackedBranch) {
		return { skip: false };
	}

	return { skip: true, ref, trackedBranch };
}
