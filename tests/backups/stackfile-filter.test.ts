/**
 * Unit tests for stackfile-filter — deciding which paths under a stack dir are
 * bind-mounted DATA (already a restic volume, exclude) vs load-bearing config (keep).
 *
 * The exclusion is derived by PARSING THE COMPOSE FILE for relative bind sources, not
 * from docker Mount.Source (a containerized Dockhand can't see the host-side source, so
 * keying on it silently no-ops). These tests feed synthetic compose strings + an
 * injected isDirRel and assert the derived relative dirs.
 */
import { describe, test, expect } from 'bun:test';
import { relativeBindDirsFromCompose, relativeBindsFromCompose, isUnderRelDir, isLoadBearingStackFile, excludableBindDirs } from '../../src/lib/server/backups/stackfile-filter';

const STACK = '/app/data/stacks/env/name';
const allDirs = () => true;   // treat every candidate as a directory
const noDirs = () => false;   // treat every candidate as a file

describe('relativeBindsFromCompose — files AND dirs (for host-path derivation)', () => {
	test('a SINGLE-FILE bind is included (dirs-only misses it)', () => {
		const c = `services:\n  app:\n    volumes:\n      - ./config.yaml:/config.yaml`;
		// dirs-only (isDirRel=false for a file) drops it; the all-binds variant keeps it so a
		// single-file-bind stack can derive its host path without the working_dir label.
		expect(relativeBindDirsFromCompose(c, STACK, noDirs)).toEqual([]);
		expect(relativeBindsFromCompose(c, STACK)).toEqual(['config.yaml']);
	});
	test('files and dirs together', () => {
		const c = `services:\n  app:\n    volumes:\n      - ./config.yaml:/c\n      - ./data:/d`;
		expect(relativeBindsFromCompose(c, STACK).sort()).toEqual(['config.yaml', 'data']);
	});
	test('named volumes and escaping/whole-dir binds are excluded', () => {
		const c = `services:\n  app:\n    volumes:\n      - mydata:/x\n      - ../outside:/y\n      - ./:/z`;
		expect(relativeBindsFromCompose(c, STACK)).toEqual([]);
	});
});

describe('relativeBindDirsFromCompose — short syntax', () => {
	test('./data and ./config relative binds -> [data, config]', () => {
		const c = `services:
  web:
    volumes:
      - ./data:/var/lib/data
      - ./config:/etc/app:ro`;
		expect(relativeBindDirsFromCompose(c, STACK, allDirs).sort()).toEqual(['config', 'data']);
	});
	test('bare "data:/x" (no ./) is a NAMED VOLUME per compose spec, not a bind -> []', () => {
		// Compose treats a bare name as a named volume; a host bind must be ./data or /abs.
		const c = `services:\n  w:\n    volumes:\n      - data:/x`;
		expect(relativeBindDirsFromCompose(c, STACK, allDirs)).toEqual([]);
	});
	test('a NAMED volume (db_data:/x) is never excluded', () => {
		// A bare name with no path-ish prefix is a named volume, not a bind.
		const c = `services:\n  db:\n    volumes:\n      - db_data:/var/lib/postgresql/data`;
		// db_data has no slash/dot -> treated as named volume -> dropped.
		// (Also, isDirRel would be false for a name that isn't a real subdir, but the
		//  parser drops it before that.)
		expect(relativeBindDirsFromCompose(c, STACK, allDirs)).toEqual([]);
	});
});

describe('relativeBindDirsFromCompose — long syntax', () => {
	test('{ type: bind, source: ./config } -> [config]', () => {
		const c = `services:
  web:
    volumes:
      - type: bind
        source: ./config
        target: /etc/app`;
		expect(relativeBindDirsFromCompose(c, STACK, allDirs)).toEqual(['config']);
	});
	test('{ type: volume, source: db } is NOT excluded', () => {
		const c = `services:
  db:
    volumes:
      - type: volume
        source: dbdata
        target: /data`;
		expect(relativeBindDirsFromCompose(c, STACK, allDirs)).toEqual([]);
	});
});

describe('relativeBindDirsFromCompose — edge cases', () => {
	test('single-FILE bind (./config.yaml) is not a dir -> not excluded', () => {
		const c = `services:\n  w:\n    volumes:\n      - ./config.yaml:/etc/app/config.yaml`;
		expect(relativeBindDirsFromCompose(c, STACK, noDirs)).toEqual([]);
	});
	test('../sibling escapes the stack dir -> dropped', () => {
		const c = `services:\n  w:\n    volumes:\n      - ../sibling:/x`;
		expect(relativeBindDirsFromCompose(c, STACK, allDirs)).toEqual([]);
	});
	test('absolute bind pointing INTO the stack dir -> relativized and kept', () => {
		const c = `services:\n  w:\n    volumes:\n      - ${STACK}/data:/x`;
		expect(relativeBindDirsFromCompose(c, STACK, allDirs)).toEqual(['data']);
	});
	test('absolute bind OUTSIDE the stack dir -> dropped', () => {
		const c = `services:\n  w:\n    volumes:\n      - /var/lib/other:/x`;
		expect(relativeBindDirsFromCompose(c, STACK, allDirs)).toEqual([]);
	});
	test('a ${VAR} in the path -> left captured (conservative), not excluded', () => {
		const c = 'services:\n  w:\n    volumes:\n      - ./data-${ENV}:/x';
		expect(relativeBindDirsFromCompose(c, STACK, allDirs)).toEqual([]);
	});
	test('trailing slash and ./ prefix normalise the same', () => {
		const c = `services:\n  w:\n    volumes:\n      - ./data/:/x`;
		expect(relativeBindDirsFromCompose(c, STACK, allDirs)).toEqual(['data']);
	});
	test('malformed / empty compose -> []', () => {
		expect(relativeBindDirsFromCompose('', STACK, allDirs)).toEqual([]);
		expect(relativeBindDirsFromCompose(':::not yaml:::', STACK, allDirs)).toEqual([]);
		expect(relativeBindDirsFromCompose('services: {}', STACK, allDirs)).toEqual([]);
	});
});

describe('relativeBindDirsFromCompose — exotic real-world compose (users have imagination)', () => {
	const c = (vol: string) => `services:\n  w:\n    volumes:\n      - ${vol}`;
	test('mode suffixes ro/rw/z/Z are stripped -> [data]', () => {
		for (const m of ['ro', 'rw', 'z', 'Z', 'cached', 'delegated']) {
			expect(relativeBindDirsFromCompose(c(`./data:/x:${m}`), STACK, allDirs)).toEqual(['data']);
		}
	});
	test('quoted sources (single and double) -> [data]', () => {
		expect(relativeBindDirsFromCompose(c('"./data:/x"'), STACK, allDirs)).toEqual(['data']);
		expect(relativeBindDirsFromCompose(c("'./data:/x'"), STACK, allDirs)).toEqual(['data']);
	});
	test('a space in the path is preserved', () => {
		expect(relativeBindDirsFromCompose(c('"./my data:/x"'), STACK, allDirs)).toEqual(['my data']);
	});
	test('a nested relative dir ./a/b -> [a/b]', () => {
		expect(relativeBindDirsFromCompose(c('./a/b:/x'), STACK, allDirs)).toEqual(['a/b']);
	});
	test('WHOLE-DIR bind (. or ./) excludes NOTHING (would strip config sidecars) -> []', () => {
		expect(relativeBindDirsFromCompose(c('.:/app'), STACK, allDirs)).toEqual([]);
		expect(relativeBindDirsFromCompose(c('./:/app'), STACK, allDirs)).toEqual([]);
		// an absolute source equal to the stack dir is the same whole-dir case
		expect(relativeBindDirsFromCompose(c(`${STACK}:/app`), STACK, allDirs)).toEqual([]);
	});
	test('${VAR} forms are all left captured (never dropped): default, bare, mid-path', () => {
		expect(relativeBindDirsFromCompose(c('${DATADIR:-./data}:/x'), STACK, allDirs)).toEqual([]);
		expect(relativeBindDirsFromCompose(c('./data-${ENV}:/x'), STACK, allDirs)).toEqual([]);
	});
	test('a bare $VAR (no braces) or ~ home is not a recognised relative bind -> []', () => {
		expect(relativeBindDirsFromCompose(c('$DATADIR/data:/x'), STACK, allDirs)).toEqual([]);
		expect(relativeBindDirsFromCompose(c('~/data:/x'), STACK, allDirs)).toEqual([]);
	});
	test('a Windows-style source (C:\\\\...) is not a posix relative/abs bind -> []', () => {
		expect(relativeBindDirsFromCompose(c('C:\\\\stuff:/x'), STACK, allDirs)).toEqual([]);
	});
	test('long syntax with read_only / propagation still resolves the bind', () => {
		const ro = `services:\n  w:\n    volumes:\n      - type: bind\n        source: ./data\n        target: /x\n        read_only: true`;
		expect(relativeBindDirsFromCompose(ro, STACK, allDirs)).toEqual(['data']);
		const prop = `services:\n  w:\n    volumes:\n      - type: bind\n        source: ./cfg\n        target: /x\n        bind:\n          propagation: rslave`;
		expect(relativeBindDirsFromCompose(prop, STACK, allDirs)).toEqual(['cfg']);
	});
	test('long syntax WITHOUT type but a relative source is treated as a bind', () => {
		const c2 = `services:\n  w:\n    volumes:\n      - source: ./data\n        target: /x`;
		expect(relativeBindDirsFromCompose(c2, STACK, allDirs)).toEqual(['data']);
	});
	test('the SAME bind across two services is de-duplicated', () => {
		const c2 = `services:\n  a:\n    volumes:\n      - ./data:/x\n  b:\n    volumes:\n      - ./data:/y`;
		expect(relativeBindDirsFromCompose(c2, STACK, allDirs)).toEqual(['data']);
	});
	test('a top-level `volumes:` named-volume declaration is ignored (only service volumes count)', () => {
		const c2 = `services:\n  w:\n    volumes:\n      - ./data:/x\nvolumes:\n  named_one:`;
		expect(relativeBindDirsFromCompose(c2, STACK, allDirs)).toEqual(['data']);
	});
	test('null volumes: / service without volumes / empty string entry -> []', () => {
		expect(relativeBindDirsFromCompose('services:\n  w:\n    volumes:', STACK, allDirs)).toEqual([]);
		expect(relativeBindDirsFromCompose('services:\n  w:\n    image: nginx', STACK, allDirs)).toEqual([]);
		expect(relativeBindDirsFromCompose(c('""'), STACK, allDirs)).toEqual([]);
	});
	test('a mix in one service: some excluded, some kept, some ignored', () => {
		const c2 = `services:
  app:
    volumes:
      - ./data:/data:ro          # dir bind -> excluded
      - ./config.yaml:/etc/c.yaml # single file -> kept
      - db_vol:/var/lib/db        # named volume -> ignored
      - /etc/localtime:/etc/localtime:ro  # abs outside -> ignored
      - ../shared:/shared         # escapes -> ignored`;
		const isDir = (r: string) => r === 'data'; // only ./data is a dir; config.yaml is a file
		expect(relativeBindDirsFromCompose(c2, STACK, isDir)).toEqual(['data']);
	});
});

describe('isLoadBearingStackFile — never excluded even under a whole-dir bind', () => {
	test('.env and .env.* and yaml/yml are load-bearing', () => {
		expect(isLoadBearingStackFile('.env')).toBe(true);
		expect(isLoadBearingStackFile('.env.production')).toBe(true);
		expect(isLoadBearingStackFile('compose.yaml')).toBe(true);
		expect(isLoadBearingStackFile('docker-compose.yml')).toBe(true);
		expect(isLoadBearingStackFile('includes/base.yaml')).toBe(true);
	});
	test('data blobs are not load-bearing', () => {
		expect(isLoadBearingStackFile('data/db.sqlite')).toBe(false);
		expect(isLoadBearingStackFile('config/nginx.conf')).toBe(false);
	});
});

describe('isUnderRelDir', () => {
	const dirs = ['data', 'config'];
	test('the dir itself and files inside it match', () => {
		expect(isUnderRelDir('data', dirs)).toBe(true);
		expect(isUnderRelDir('data/db.sqlite', dirs)).toBe(true);
		expect(isUnderRelDir('config/nginx.conf', dirs)).toBe(true);
	});
	test('root config files do not match', () => {
		expect(isUnderRelDir('compose.yaml', dirs)).toBe(false);
		expect(isUnderRelDir('.env', dirs)).toBe(false);
	});
	test('segment-aware: a prefix-sharing sibling does not match', () => {
		expect(isUnderRelDir('data-backup/x', dirs)).toBe(false);
		expect(isUnderRelDir('datastore', dirs)).toBe(false);
	});
	test('no dirs -> nothing matches', () => {
		expect(isUnderRelDir('data/db', [])).toBe(false);
	});
});

/**
 * A bind dir is dropped from the stack-dir capture because it is captured as its own
 * volume. When it is not in the volume set, dropping it removes the directory from
 * the snapshot altogether - verified against real restic: a clappo-shaped stack with
 * ./scripts and ./migrations bound backed up 2 files (compose + an unbound dir), and
 * after restore both directories were gone, which is what broke the redeploy.
 */
describe('excludableBindDirs', () => {
	const STACK = '/opt/dockhand/stacks/srv1/clappo';

	test('a dir with its own captured volume is excludable', () => {
		expect(excludableBindDirs(['scripts'], STACK, [`${STACK}/scripts`])).toEqual(['scripts']);
	});

	test('a dir nobody captures is kept in the stack files', () => {
		expect(excludableBindDirs(['scripts'], STACK, [`${STACK}/data`])).toEqual([]);
	});

	test('each dir is judged on its own', () => {
		expect(excludableBindDirs(['scripts', 'migrations'], STACK, [`${STACK}/migrations`]))
			.toEqual(['migrations']);
	});

	// No volumes at all is the case that motivated this: the capture would otherwise
	// exclude every bind dir and store none of them.
	test('with no volumes captured, nothing is excludable', () => {
		expect(excludableBindDirs(['scripts', 'migrations'], STACK, [])).toEqual([]);
	});

	test('a volume covering the whole stack dir covers its bind dirs', () => {
		expect(excludableBindDirs(['scripts'], STACK, [STACK])).toEqual(['scripts']);
	});

	test('a trailing slash on either side does not change the verdict', () => {
		expect(excludableBindDirs(['scripts/'], STACK, [`${STACK}/scripts/`])).toEqual(['scripts/']);
	});

	// A named volume's source is its name, not a path; it can never cover a bind dir.
	test('a named volume does not count as coverage', () => {
		expect(excludableBindDirs(['scripts'], STACK, ['clappo_pgdata'])).toEqual([]);
	});

	test('a similarly-named sibling is not coverage', () => {
		expect(excludableBindDirs(['scripts'], STACK, [`${STACK}/scripts-old`])).toEqual([]);
	});

	// The direction that matters: a SHORTER path sharing a prefix. Matching without
	// the separator would let /clappo/scr "cover" /clappo/scripts and drop it.
	test('a shorter path sharing a prefix is not coverage', () => {
		expect(excludableBindDirs(['scripts'], STACK, [`${STACK}/scr`])).toEqual([]);
		expect(excludableBindDirs(['migrations'], STACK, [`${STACK}/migr`])).toEqual([]);
	});

	test('a path outside the stack dir entirely is not coverage', () => {
		expect(excludableBindDirs(['scripts'], STACK, ['/mnt/tank/scripts'])).toEqual([]);
	});

	// A compose bind may spell a dir through its sibling (`./data/../scripts`), which
	// docker accepts and the daemon reports resolved. Comparing the raw strings let the
	// `data` volume "cover" `scripts`, dropping a dir nothing captured.
	test('a sibling volume does not cover a dir reached through it', () => {
		expect(excludableBindDirs(['data/../scripts', 'data'], STACK, [`${STACK}/data`]))
			.toEqual(['data']);
	});

	test('a dotted dir is still covered by its own volume, once canonicalised', () => {
		expect(excludableBindDirs(['data/../scripts'], STACK, [`${STACK}/scripts`]))
			.toEqual(['data/../scripts']);
	});

	test('a dotted covered source is canonicalised too', () => {
		expect(excludableBindDirs(['scripts'], STACK, [`${STACK}/data/../scripts`]))
			.toEqual(['scripts']);
	});

	test('. and doubled slashes do not change the verdict', () => {
		expect(excludableBindDirs(['./scripts'], STACK, [`${STACK}//scripts`])).toEqual(['./scripts']);
	});

	// A host-root bind (`/:/host:ro`, what host-monitoring agents mount) is not coverage:
	// restore reads a stack's files only from /volumes/__dockhand_stackdir__, so a dir
	// excluded on its strength is in the snapshot but unreachable to any restore.
	test('a host-root bind is not coverage', () => {
		expect(excludableBindDirs(['scripts', 'migrations'], STACK, ['/'])).toEqual([]);
	});

	test('a root bind alongside a real covering volume leaves that one excludable', () => {
		expect(excludableBindDirs(['scripts', 'migrations'], STACK, ['/', `${STACK}/scripts`]))
			.toEqual(['scripts']);
	});

	test('a prefix sibling of the stack root is not coverage', () => {
		expect(excludableBindDirs(['s'], '/opt-other/app', ['/opt'])).toEqual([]);
	});

	test('no bind dirs means nothing to decide', () => {
		expect(excludableBindDirs([], STACK, [`${STACK}/scripts`])).toEqual([]);
	});
});
