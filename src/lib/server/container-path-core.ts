/**
 * Validate a path the user asked the container file browser to read, write, list or move.
 *
 * REJECTS a malformed/dangerous path (throws) and returns a valid path UNCHANGED - it removes
 * nothing, so a legal filename such as `olcDatabase={2}mdb.ldif` reaches the daemon intact.
 * There is no need to strip shell metacharacters: every caller passes the path as an argv-array
 * element to the Docker exec API (execve, no shell) or through encodeURIComponent into a Docker
 * archive URL, so `{}()[]=;&|$` and the like carry no special meaning at the sink.
 *
 * The reject set is the common, safe one for BOTH an absolute container path and a
 * volume-relative path (the volume browser joins its path onto the mount point, so it is
 * legitimately relative and must NOT be forced absolute):
 *  - a NUL byte  -> C-string truncation;
 *  - a `..` path SEGMENT -> keeps the browser from walking out of the directory it listed,
 *    in both the container-FS and volume-mount cases.
 * A name that merely starts with dots (`.env`, `..foo`) is a normal filename, not a `..`
 * segment, and is allowed.
 */
export function assertSafeContainerPath(path: string): string {
	if (typeof path !== 'string' || path === '') {
		throw new Error('Invalid path: empty');
	}
	if (path.includes('\0')) {
		throw new Error('Invalid path: contains a null byte');
	}
	if (path.split('/').some((segment) => segment === '..')) {
		throw new Error('Invalid path: contains a ".." segment');
	}
	return path;
}
