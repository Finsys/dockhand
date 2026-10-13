/**
 * Decide what a stack directory's symlinks mean for the local deploy copy.
 *
 * A link is CARRIED when it stays inside the stack, and REFUSED otherwise. Carrying it
 * verbatim is what keeps it relative: resolving it writes an absolute path into the
 * clone, and the next deploy then finds the destination link resolving onto its own
 * source and cp refuses the copy. Three shapes are refused:
 *
 *   - an ABSOLUTE target, valid only for the one directory it was written in, so it
 *     breaks on a remote deploy or a restore elsewhere;
 *   - a target OUTSIDE the stack, which would let a repository reach the host;
 *   - a target that is an ANCESTOR of the link's own directory, which is what makes cp
 *     fail on the second deploy even with links kept verbatim (measured: `sub/up -> ..`
 *     is the only shape that does);
 *   - a target that RESOLVES TO NOTHING, which cp cannot stat in the destination on the
 *     next deploy (measured as EEXIST, and it fails that way without verbatim links
 *     too). `exists` decides this, injected so the module stays pure.
 *
 * The check is LEXICAL, which is enough for the copy: it refuses each link on its own,
 * so a chain whose first hop leaves the stack is broken at that hop and the rest
 * resolves to nothing. It is NOT enough to decide whether reading THROUGH a link stays
 * inside, which is why nothing here follows one.
 *
 * Pure: paths in, decisions out. The caller does the I/O.
 */
import { resolve, dirname, isAbsolute, sep } from 'node:path';

export type SymlinkVerdict =
	| { kind: 'carry'; target: string }
	| { kind: 'refuse'; target: string; reason: string };

/** Is `abs` inside `root`, or root itself? */
function within(abs: string, root: string): boolean {
	return abs === root || abs.startsWith(root + sep);
}

/**
 * Judge one symlink. `linkPath` and `root` are absolute; `target` is the link's raw
 * value as readlink returns it.
 */
export function judgeSymlink(
	linkPath: string,
	target: string,
	root: string,
	exists?: (absPath: string) => boolean
): SymlinkVerdict {
	if (isAbsolute(target)) {
		return { kind: 'refuse', target, reason: 'the target is an absolute path' };
	}
	const rootAbs = resolve(root);
	const linkDir = dirname(resolve(linkPath));
	const resolved = resolve(linkDir, target);
	if (!within(resolved, rootAbs)) {
		return { kind: 'refuse', target, reason: 'the target is outside the stack directory' };
	}
	if (within(linkDir, resolved)) {
		return { kind: 'refuse', target, reason: 'the target contains the link itself' };
	}
	if (exists && !exists(resolved)) {
		return { kind: 'refuse', target, reason: 'the target does not exist' };
	}
	return { kind: 'carry', target };
}
