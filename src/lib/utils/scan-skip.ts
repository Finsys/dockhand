// Whether the stack-adoption scan should skip a directory (#1251). Pure + import-light so
// it's unit-testable without pulling in the scanner's db/docker deps.

// Known noise directories that never hold an adoptable stack.
export const SKIP_DIRECTORIES = ['.git', 'node_modules', '.docker', '__pycache__', '.venv', 'venv'];

// Skip a known noise dir, or any hidden (dot-prefixed) dir. Dotfolders like btrfs
// `.snapshots` otherwise surface one duplicate stack per snapshot; a stack directory is
// never legitimately dot-prefixed.
export function shouldSkipScanDir(name: string): boolean {
	return SKIP_DIRECTORIES.includes(name) || name.startsWith('.');
}
