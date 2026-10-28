/**
 * The newer-version suggestion a container was last NOTIFIED about, kept apart from
 * the pending row (which only shows the latest run, and goes away when a run finds
 * nothing). A notification goes out only when a suggestion lies beyond that mark:
 * built later, or when dates are unknown, a higher version. So a suggestion that
 * wanders between pending tags - several betas the name order cannot rank, a
 * registry that answers one run and not the next - notifies once, not on every
 * change. Pure: no I/O.
 */
import { compareParts, parseTag } from './tag-parser';
import { applyTagTransform, type TagTransform } from './tag-transform';
import type { NewerVersion } from './find-newer';

export interface NotifiedMark {
	/** `registry/repo`, so a container moved to another image starts afresh. */
	repo: string;
	tag: string;
	digest?: string;
	imageId?: string;
	createdAt?: string;
}

export function notifiedMarkFor(target: NewerVersion, repo: string): NotifiedMark {
	return {
		repo,
		tag: target.tag,
		...(target.digest ? { digest: target.digest } : {}),
		...(target.imageId ? { imageId: target.imageId } : {}),
		...(target.createdAt ? { createdAt: target.createdAt } : {})
	};
}

const instant = (value: string | undefined): number | null => {
	const t = value ? Date.parse(value) : NaN;
	return Number.isFinite(t) ? t : null;
};

/**
 * Whether `target` is worth a notification after `mark`. Another tag of the image
 * already announced never is. Between two dated images the later build is; without
 * both dates the higher version is, read the way the check read it.
 */
export function isBeyondNotified(
	target: NewerVersion,
	repo: string,
	mark: NotifiedMark | undefined,
	parsing: { versionPattern?: RegExp | null; tagTransform?: TagTransform | null } = {}
): boolean {
	if (!mark || mark.repo !== repo) return true;
	if (target.tag === mark.tag) return false;
	if (target.imageId && target.imageId === mark.imageId) return false;
	if (target.digest && target.digest === mark.digest) return false;
	const built = instant(target.createdAt);
	const markBuilt = instant(mark.createdAt);
	if (built !== null && markBuilt !== null) return built > markBuilt;
	const parse = (tag: string) => parseTag(applyTagTransform(parsing.tagTransform ?? null, tag), parsing.versionPattern ?? null);
	const a = parse(target.tag);
	const b = parse(mark.tag);
	return !a || !b || compareParts(a, b) > 0;
}
