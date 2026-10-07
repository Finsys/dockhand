/** Best-effort discovery from the updating container's own Compose labels. */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { posix, win32 } from 'node:path';
import { parseCompose } from './compose-validate/parse';
import { isCopyFilePath } from './container-copy-files';

type Labels = Record<string, string> | null | undefined;
const PREFIX = 'com.docker.compose.';
const MAX_CONFIG_BYTES = 4 * 1024 * 1024;
const MAX_CONFIG_FILES = 16;

function mapping(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? value as Record<string, unknown> : undefined;
}

export function composeCopyFileConfigPaths(labels: Labels): string[] {
	const files = labels?.[PREFIX + 'project.config_files'];
	const workingDir = labels?.[PREFIX + 'project.working_dir'];
	if (!files || !workingDir || !labels?.[PREFIX + 'project'] || !labels?.[PREFIX + 'service']) return [];
	const windows = /^[a-z]:[\\/]|^\\\\/i.test(workingDir);
	const paths = windows ? win32 : posix;
	if (!paths.isAbsolute(workingDir)) return [];
	// Compose stamps comma-separated config_files on every platform. Also accept
	// semicolon-separated Windows lists, without splitting drive-letter colons.
	const entries = files.split(windows && !files.includes(',') ? ';' : ',').map(file => file.trim());
	if (entries.length > MAX_CONFIG_FILES || entries.some(file => !file || file === '-' || file.includes('\0'))) return [];
	return [...new Set(entries.map(file => paths.resolve(workingDir, file)))];
}

/** Resolve the subset needed for env-secret paths, never environment values. */
export function parseComposeCopyFilePaths(sources: readonly string[], labels: Labels): string[] {
	const serviceName = labels?.[PREFIX + 'service'];
	if (!serviceName || !labels?.[PREFIX + 'project']) return [];
	const definitions = new Map<string, Record<string, unknown>>();
	const references = new Map<string, string>();
	for (const source of sources) {
		const { doc, parseError } = parseCompose(source);
		// Includes/extends need Compose's full project loader. Do not guess paths.
		if (!doc || parseError || doc.include != null) return [];
		const secrets = mapping(doc.secrets);
		if (doc.secrets != null && !secrets) return [];
		for (const [name, value] of Object.entries(secrets ?? {})) {
			const definition = mapping(value);
			if (!definition) return [];
			definitions.set(name, { ...definitions.get(name), ...definition });
		}
		// The container's project label is authoritative (Compose -p can override
		// top-level name). Its own file list and service label identify the owner.
		const service = mapping(mapping(doc.services)?.[serviceName]);
		if (!service) continue;
		if (service.extends != null) return [];
		if (service.secrets == null) continue;
		if (!Array.isArray(service.secrets)) return [];
		for (const reference of service.secrets) {
			const long = mapping(reference);
			const name = typeof reference === 'string' ? reference : long?.source;
			const target = long?.target ?? name;
			if (typeof name !== 'string' || !name || typeof target !== 'string' || !target) return [];
			// Interpolated names/targets cannot be resolved safely from these labels.
			// Skip discovery for this service rather than retain an overridden target.
			if (name.includes('$') || target.includes('$')) return [];
			const path = target.startsWith('/') ? target : '/run/secrets/' + target;
			if (!isCopyFilePath(path)) return [];
			// Compose merges service secrets by target; later files replace the same
			// target while distinct targets append. Definitions can be in other files.
			references.set(path, name);
		}
	}
	return [...references].filter(([, name]) => {
		const secret = definitions.get(name);
		return typeof secret?.environment === 'string' && secret.environment.length > 0 &&
			secret.file == null && secret.content == null && !secret.external;
	}).map(([path]) => path);
}

export async function discoverComposeCopyFilePaths(labels: Labels): Promise<string[]> {
	try {
		const sources: string[] = [];
		let remaining = MAX_CONFIG_BYTES;
		for (const path of composeCopyFileConfigPaths(labels)) {
			// Nonblocking open + regular-file check avoids hanging on a FIFO named in
			// a label. Bound reads even if the file grows after stat.
			const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
			try {
				const stat = await file.stat();
				if (!stat.isFile() || stat.size > remaining) return [];
				const buffer = Buffer.alloc(Math.min(stat.size + 1, remaining + 1));
				let length = 0;
				while (length < buffer.length) {
					const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
					if (!bytesRead) break;
					length += bytesRead;
				}
				if (length > stat.size || length > remaining) return [];
				remaining -= length;
				sources.push(buffer.toString('utf8', 0, length));
			} finally {
				await file.close();
			}
		}
		return parseComposeCopyFilePaths(sources, labels);
	} catch {
		// Files may live on another host (including Hawser Edge) or be unavailable
		// inside Dockhand. Never log file contents/errors or fail recreation here.
		return [];
	}
}
