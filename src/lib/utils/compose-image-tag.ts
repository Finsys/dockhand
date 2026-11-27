import { repoBaseOf } from './pinned-ref';

export type ComposeImageTagResult =
	| { ok: true; content: string; image: string }
	| { ok: false; reason: 'service_not_found' | 'image_not_found' | 'variable' | 'repo_mismatch' | 'unchanged' | 'invalid_tag' };

const KEY_LINE = /^(\s*)(["']?)([^"'#:\s]+)\2\s*:(\s.*|)$/;
const IMAGE_LINE = /^(\s*image\s*:\s*)(["']?)([^"'\s#]+)\2(\s+#.*|\s*)$/;

// The tag and digest come from a registry tag list, which is untrusted input. They are
// written verbatim into the image line, so a value carrying whitespace or a newline
// would inject sibling YAML into the compose file. Accept only the Docker grammar.
const TAG_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const DIGEST_RE = /^[A-Za-z0-9_+.-]+:[A-Za-z0-9=_.:-]+$/;

function indentOf(line: string): number {
	return line.length - line.trimStart().length;
}

function isBlank(line: string): boolean {
	const t = line.trim();
	return t === '' || t.startsWith('#');
}

function keyOf(line: string): string | null {
	return KEY_LINE.exec(line)?.[3] ?? null;
}

function normalizeRepo(repo: string): string {
	return repo.replace(/^(index\.)?docker\.io\//, '').replace(/^library\//, '');
}

export function replaceServiceImageTag(
	compose: string,
	service: string,
	runningImage: string,
	newTag: string,
	newDigest?: string | null
): ComposeImageTagResult {
	if (!TAG_RE.test(newTag)) return { ok: false, reason: 'invalid_tag' };
	if (newDigest && !DIGEST_RE.test(newDigest)) return { ok: false, reason: 'invalid_tag' };

	const eol = compose.includes('\r\n') ? '\r\n' : '\n';
	const lines = compose.split(/\r?\n/);

	const servicesAt = lines.findIndex((l) => /^services\s*:\s*(#.*)?$/.test(l));
	if (servicesAt === -1) return { ok: false, reason: 'service_not_found' };

	let serviceAt = -1;
	let serviceIndent = -1;
	for (let i = servicesAt + 1; i < lines.length; i++) {
		if (isBlank(lines[i])) continue;
		const indent = indentOf(lines[i]);
		if (indent === 0) break;
		if (serviceIndent === -1) serviceIndent = indent;
		if (indent === serviceIndent && keyOf(lines[i]) === service) {
			serviceAt = i;
			break;
		}
	}
	if (serviceAt === -1) return { ok: false, reason: 'service_not_found' };

	let imageAt = -1;
	let childIndent = -1;
	for (let i = serviceAt + 1; i < lines.length; i++) {
		if (isBlank(lines[i])) continue;
		const indent = indentOf(lines[i]);
		if (indent <= serviceIndent) break;
		if (childIndent === -1) childIndent = indent;
		if (indent === childIndent && keyOf(lines[i]) === 'image') {
			imageAt = i;
			break;
		}
	}
	if (imageAt === -1) return { ok: false, reason: 'image_not_found' };

	const line = lines[imageAt];
	const match = IMAGE_LINE.exec(line);
	if (!match) return { ok: false, reason: line.includes('$') ? 'variable' : 'image_not_found' };
	const [, prefix, quote, value, rest] = match;
	if (value.includes('$')) return { ok: false, reason: 'variable' };

	const repo = repoBaseOf(value);
	if (normalizeRepo(repo) !== normalizeRepo(repoBaseOf(runningImage))) {
		return { ok: false, reason: 'repo_mismatch' };
	}

	const image = `${repo}:${newTag}${value.includes('@') && newDigest ? `@${newDigest}` : ''}`;
	if (image === value) return { ok: false, reason: 'unchanged' };

	lines[imageAt] = `${prefix}${quote}${image}${quote}${rest}`;
	return { ok: true, content: lines.join(eol), image };
}
