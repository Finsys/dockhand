/**
 * Reading `restic ls --json <snapshot> /volumes/` output: the volume keys a snapshot holds,
 * and which of them is a single FILE (a single-file bind such as `./config.yaml:/x`), which a
 * restore must write as a file rather than as a directory's contents.
 */
export function snapshotVolumeNodes(stdout: string, isReserved: (key: string) => boolean): { names: string[]; files: string[] } {
	const names = new Set<string>();
	const files = new Set<string>();
	for (const line of stdout.split('\n')) {
		let e: any;
		try { e = JSON.parse(line.trim()); } catch { continue; }
		// Either node discriminator: message_type (current restic) or struct_type (deprecated).
		if ((e?.message_type !== 'node' && e?.struct_type !== 'node') || typeof e.path !== 'string' || !e.path.startsWith('/volumes/')) continue;
		const parts = e.path.split('/');
		if (parts.length < 3 || !parts[2] || isReserved(parts[2])) continue;
		names.add(parts[2]);
		if (parts.length === 3 && e.type === 'file') files.add(parts[2]);
	}
	return { names: [...names], files: [...files] };
}
