/**
 * A git checkout tracks a file as 100644 or 100755, so the exec bit is the only
 * mode a stack can carry. Return 0o755 for an executable file, undefined otherwise
 * so the caller keeps the modes map sparse.
 */
export function stackFileExecMode(mode: number): number | undefined {
	return mode & 0o111 ? 0o755 : undefined;
}
