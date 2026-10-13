// A coming-soon changelog entry (comingSoon: true) is an unreleased placeholder
// used for the webpage's "what's next" section. It must never appear in the app's
// released-version surfaces (About list, What's New, self-update release notes),
// which otherwise render it as the latest shipped version.

export interface ChangelogEntryLike {
	comingSoon?: boolean;
}

/** Drop unreleased (comingSoon) entries, keeping only shipped releases. */
export function releasedEntries<T extends ChangelogEntryLike>(entries: T[]): T[] {
	return entries.filter((e) => !e.comingSoon);
}
