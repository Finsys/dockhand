/**
 * stackfile-filter.ts — decide which entries under a stack directory belong in the
 * metadata "stackfiles/" capture, and which are bind-mounted DATA that restic already
 * backs up separately as a volume.
 *
 * A common stack layout keeps the bind data inside the stack dir:
 *
 *   stack/
 *   ├── compose.yaml        <- config, MUST stay in stackfiles/ (redeploy reads it)
 *   ├── .env                <- config, MUST stay
 *   ├── config/             <- bind-mounted -> restic volume, exclude
 *   └── data/               <- bind-mounted -> restic volume, exclude
 *
 * We skip any DIRECTORY the compose file bind-mounts from inside the stack dir: it is already
 * backed up as its own restic volume, so capturing it here too would double-back-up and blow the
 * capture cap, marking the snapshot INCOMPLETE.
 *
 * WHY WE PARSE THE COMPOSE, NOT the docker Mount.Source:
 * The walk reads the stack dir in DOCKHAND's namespace (`/app/data/stacks/...`), but a
 * bind's `Mount.Source` is the DAEMON HOST path (`/docker/data/...` or `/tmp/...`) which
 * a containerized Dockhand cannot see or stat — so keying the exclusion on Mount.Source
 * silently no-ops for every Dockerized install. The compose file, which Dockhand always
 * has locally, declares binds RELATIVE to the stack dir (`./data`) — the same namespace
 * the walk already computes `relative(stackDir, abs)` in. So we derive the excluded dirs
 * from the compose text and compare on relative paths: namespace-agnostic, works
 * containerized / on-host / remote alike.
 *
 * Hard rules (adversarial review):
 *  - NEVER exclude compose/`.yaml`/`.yml`/`.env` (`isLoadBearingStackFile`) — a whole-dir
 *    bind `./:/app` must not strand them or restore can't redeploy.
 *  - Exclude only DIRECTORY binds — a single-FILE bind (`./cfg.yaml:/x`) is config kept.
 *  - Named volumes (`type: volume`, or a non-relative source) are NEVER excluded.
 *  - A `${VAR}` in a bind path is left CAPTURED (conservative over-capture, never drops
 *    a needed file).
 *
 * Pure and dependency-light (js-yaml is already a repo dep); the directory check is
 * injected so it stays unit-testable.
 */
import yaml from 'js-yaml';

/** Strip a trailing slash and a leading `./`; keep the rest. */
function normRel(p: string): string {
	let s = p.trim().replace(/\/+$/, '');
	if (s.startsWith('./')) s = s.slice(2);
	return s;
}

/** A load-bearing stack file that must NEVER be excluded, regardless of a bind that
 * happens to cover it: compose/`.yaml`/`.yml` (the compose graph) and `.env*` at any
 * level. Data dirs are excluded by the bind rule, not by extension. */
export function isLoadBearingStackFile(relPath: string): boolean {
	const base = relPath.split('/').pop() ?? relPath;
	if (base === '.env' || base.startsWith('.env.')) return true;
	return /\.ya?ml$/i.test(base);
}

/** The bind `source` from one compose `volumes:` entry, short or long syntax, or null
 * if it isn't a bind we care about (named volume, no source). */
function bindSourceOf(entry: unknown): string | null {
	if (typeof entry === 'string') {
		// "src:target[:mode]" — a bind if src is a path (starts with . or /). A bare
		// name ("db_data:/x") is a NAMED VOLUME — not a bind, skip.
		const src = entry.split(':')[0];
		if (src.startsWith('.') || src.startsWith('/')) return src;
		return null;
	}
	if (entry && typeof entry === 'object') {
		const e = entry as { type?: string; source?: string };
		if (e.type === 'volume') return null; // named volume
		if (typeof e.source === 'string') {
			if (e.type === 'bind' || e.source.startsWith('.') || e.source.startsWith('/')) return e.source;
		}
	}
	return null;
}

/**
 * Directory bind sources declared in the compose file, expressed as paths RELATIVE to
 * the stack dir — e.g. `['data', 'config']`. `stackDir` is used only to relativize an
 * absolute bind that points into the stack dir. `isDirRel(rel)` decides whether a given
 * stack-dir-relative path is a directory (in the walk's own namespace) — a single-file
 * bind is NOT returned. `${VAR}` sources are dropped (left to be captured).
 */
export function relativeBindDirsFromCompose(
	composeContent: string,
	stackDir: string,
	isDirRel: (rel: string) => boolean
): string[] {
	let doc: unknown;
	try { doc = yaml.load(composeContent); } catch { return []; }
	const services = (doc as { services?: Record<string, unknown> } | null)?.services;
	if (!services || typeof services !== 'object') return [];

	const rels = new Set<string>();
	for (const svc of Object.values(services)) {
		const vols = (svc as { volumes?: unknown[] } | null)?.volumes;
		if (!Array.isArray(vols)) continue;
		for (const entry of vols) {
			const src = bindSourceOf(entry);
			if (!src) continue;
			if (src.includes('${')) continue; // unresolved var -> capture, don't risk dropping
			let rel: string;
			if (src.startsWith('/')) {
				// Absolute bind: keep only if it resolves INSIDE the stack dir.
				const r = relativePosix(stackDir, src);
				if (r === '' || r.startsWith('..')) continue;
				rel = r;
			} else {
				rel = normRel(src);
				if (rel === '' || rel.startsWith('..')) continue; // escapes stack dir
			}
			// A whole-dir bind (`.`, `./`, or an absolute source == the stack dir) would
			// mean "exclude everything" — refuse it: it would strip config sidecars that
			// aren't load-bearing (nginx.conf, certs/). Over-capture the whole dir instead
			// (safe: nothing lost, compose kept). isLoadBearingStackFile can't rescue a
			// non-yaml sidecar, so the only safe move here is to not exclude at all.
			if (rel === '.' || rel === '') continue;
			if (isDirRel(rel)) rels.add(rel);
		}
	}
	return [...rels];
}

/**
 * Every RELATIVE bind's path below the stack dir - FILES and DIRS alike (`./config.yaml`,
 * `./data`). Unlike relativeBindDirsFromCompose (dirs only, for EXCLUDE), this feeds host-path
 * DERIVATION: a single-file bind's daemon-reported mount.Source still pins the stack dir (strip
 * the tail), so a bind-less-but-single-file stack resolves without depending on the working_dir
 * label (which needs the container to be listable - a timing race under load). Whole-dir binds
 * (`.`/`./`) are skipped (the source IS the stack dir; the bind-derived path adds nothing).
 */
export function relativeBindsFromCompose(composeContent: string, stackDir: string): string[] {
	let doc: unknown;
	try { doc = yaml.load(composeContent); } catch { return []; }
	const services = (doc as { services?: Record<string, unknown> } | null)?.services;
	if (!services || typeof services !== 'object') return [];

	const rels = new Set<string>();
	for (const svc of Object.values(services)) {
		const vols = (svc as { volumes?: unknown[] } | null)?.volumes;
		if (!Array.isArray(vols)) continue;
		for (const entry of vols) {
			const src = bindSourceOf(entry);
			if (!src || src.includes('${')) continue;
			let rel: string;
			if (src.startsWith('/')) {
				const r = relativePosix(stackDir, src);
				if (r === '' || r.startsWith('..')) continue;
				rel = r;
			} else {
				rel = normRel(src);
				if (rel === '' || rel.startsWith('..')) continue;
			}
			if (rel === '.' || rel === '') continue;
			rels.add(rel);
		}
	}
	return [...rels];
}

/** posix `relative(from, to)` on already-clean absolute paths (no realpath). */
function relativePosix(from: string, to: string): string {
	const a = from.replace(/\/+$/, '').split('/');
	const b = to.replace(/\/+$/, '').split('/');
	let i = 0;
	while (i < a.length && i < b.length && a[i] === b[i]) i++;
	const up = a.slice(i).map(() => '..');
	return [...up, ...b.slice(i)].join('/');
}

/** True when `relPath` IS one of the excluded relative dirs, or lives inside one.
 * Segment-aware so `data-backup` doesn't match `data`. */
export function isUnderRelDir(relPath: string, relDirs: string[]): boolean {
	const t = normRel(relPath);
	for (const raw of relDirs) {
		const d = normRel(raw);
		if (t === d) return true;
		if (t.startsWith(d + '/')) return true;
	}
	return false;
}
