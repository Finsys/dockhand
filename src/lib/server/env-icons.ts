import { resolve } from 'path';
import { existsSync, mkdirSync, writeFileSync, unlinkSync, readFileSync } from 'fs';

function getIconsDir(): string {
	const dataDir = process.env.DATA_DIR || './data';
	const dir = resolve(dataDir, 'icons');
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	return dir;
}

export function saveEnvironmentIcon(envId: number, base64Data: string): void {
	const dir = getIconsDir();
	// Strip data URL prefix if present
	const base64 = base64Data.replace(/^data:image\/\w+;base64,/, '');
	const buffer = Buffer.from(base64, 'base64');
	writeFileSync(resolve(dir, `env-${envId}.webp`), buffer);
}

export function deleteEnvironmentIcon(envId: number): void {
	const dir = getIconsDir();
	const path = resolve(dir, `env-${envId}.webp`);
	if (existsSync(path)) {
		unlinkSync(path);
	}
}

export function getEnvironmentIconBuffer(envId: number): Buffer | null {
	const dir = getIconsDir();
	const path = resolve(dir, `env-${envId}.webp`);
	if (!existsSync(path)) {
		return null;
	}
	return readFileSync(path);
}
