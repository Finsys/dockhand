/**
 * Moving a stack directory's entries for relocate, kept out of the route so it can
 * be tested on real directories. A rename moves an entry itself and reads nothing,
 * so it is not guarded; what is guarded is a move that changes where an entry
 * leads, and the cross-filesystem copy, which reads and writes through links.
 */
import { readdirSync, renameSync, readFileSync, writeFileSync, unlinkSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { isForbiddenStackPath } from './fs-guard';

export function moveDirEntries(
	oldDir: string,
	newDir: string,
	rename: (from: string, to: string) => void = renameSync
): { movedFiles: string[]; errors: string[] } {
	const movedFiles: string[] = [];
	const errors: string[] = [];

	for (const file of readdirSync(oldDir)) {
		const oldFilePath = join(oldDir, file);
		const newFilePath = join(newDir, file);
		const protectedBefore = isForbiddenStackPath(oldFilePath);

		try {
			rename(oldFilePath, newFilePath);
		} catch (renameErr: any) {
			if (renameErr.code !== 'EXDEV') {
				errors.push(`Failed to move ${file}: ${renameErr.message}`);
				continue;
			}
			// The copy reads the source and writes the target through any symlink.
			if (protectedBefore || isForbiddenStackPath(newFilePath)) {
				errors.push(`Skipped ${file}: path is not allowed`);
				continue;
			}
			try {
				writeFileSync(newFilePath, readFileSync(oldFilePath));
				unlinkSync(oldFilePath);
				movedFiles.push(file);
			} catch (copyErr: any) {
				errors.push(`Failed to copy ${file}: ${copyErr.message}`);
			}
			continue;
		}

		// A relative symlink resolves from its new directory once moved, so the move
		// itself can make it lead into a protected location. Put such an entry back.
		if (!protectedBefore && lstatSync(newFilePath).isSymbolicLink() && isForbiddenStackPath(newFilePath)) {
			rename(newFilePath, oldFilePath);
			errors.push(`Skipped ${file}: it would lead into a protected location once moved`);
			continue;
		}
		movedFiles.push(file);
	}

	return { movedFiles, errors };
}
