import { resolve } from 'path';
import { existsSync, mkdirSync, writeFileSync, unlinkSync, readFileSync } from 'fs';
import { createHash } from 'crypto';

// Re-export so the icon endpoints share ONE magic-byte check with stacks.
export { looksLikeImage } from './stack-icons';

/**
 * Custom uploaded container icons, mirroring stack-icons.ts. A container has no
 * stable numeric id (it is keyed by name+env, the name being stable across
 * recreation), so the on-disk filename is a hash of name+env - collision-free and
 * filesystem-safe regardless of the container name.
 */
function getIconsDir(): string {
	const dataDir = process.env.DATA_DIR || './data';
	const dir = resolve(dataDir, 'icons', 'containers');
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	return dir;
}

/** Stable, path-safe basename for a container's custom icon. */
export function containerIconKey(containerName: string, envId: number | null): string {
	return createHash('sha256').update(`${containerName} ${envId ?? ''}`).digest('hex').slice(0, 32);
}

function iconPath(containerName: string, envId: number | null): string {
	return resolve(getIconsDir(), `${containerIconKey(containerName, envId)}.webp`);
}

export function saveContainerIcon(containerName: string, envId: number | null, base64Data: string): void {
	const base64 = base64Data.replace(/^data:image\/\w+;base64,/, '');
	writeFileSync(iconPath(containerName, envId), Buffer.from(base64, 'base64'));
}

export function deleteContainerIcon(containerName: string, envId: number | null): void {
	const path = iconPath(containerName, envId);
	if (existsSync(path)) unlinkSync(path);
}

export function getContainerIconBuffer(containerName: string, envId: number | null): Buffer | null {
	const path = iconPath(containerName, envId);
	return existsSync(path) ? readFileSync(path) : null;
}
