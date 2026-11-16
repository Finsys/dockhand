// Moves an environment's on-disk dirs, repoints its stored stack paths and writes the new
// name, undoing exactly what it did (rows first, then dirs) when a later step fails.

export interface EnvRenameDeps<T> {
	fs: { exists(path: string): boolean; rename(from: string, to: string): void };
	dirs: Array<{ from: string; to: string }>;
	stacks: { from: string; to: string };
	// Rebases rows from -> to, pushing each changed row id into `changed`; only `onlyIds` when given.
	rebaseRows(from: string, to: string, changed: number[], onlyIds?: number[]): Promise<unknown>;
	// Writes the env row; undefined means the env is gone.
	update(): Promise<T | undefined>;
}

export type EnvRenameResult<T> = { moveError: unknown } | { value: T | undefined; repointed: number };

export async function renameEnvStorage<T>(d: EnvRenameDeps<T>): Promise<EnvRenameResult<T>> {
	const moved: Array<{ from: string; to: string }> = [];
	const revertDirs = () => {
		for (const m of [...moved].reverse()) {
			try {
				d.fs.rename(m.to, m.from);
			} catch (e) {
				console.error(`[Environments] Failed to move ${m.to} back to ${m.from}:`, e);
			}
		}
	};

	try {
		for (const dir of d.dirs) {
			if (!d.fs.exists(dir.from)) continue;
			d.fs.rename(dir.from, dir.to);
			moved.push(dir);
		}
	} catch (err) {
		revertDirs();
		return { moveError: err };
	}

	const changed: number[] = [];
	const undo = async () => {
		if (changed.length > 0) {
			try {
				await d.rebaseRows(d.stacks.to, d.stacks.from, [], changed);
			} catch (e) {
				console.error('[Environments] Failed to revert stack paths after a failed rename:', e);
			}
		}
		revertDirs();
	};

	try {
		await d.rebaseRows(d.stacks.from, d.stacks.to, changed);
		const value = await d.update();
		if (value === undefined) {
			await undo();
			return { value, repointed: 0 };
		}
		return { value, repointed: changed.length };
	} catch (err) {
		await undo();
		throw err;
	}
}
