/**
 * Compose Validate - preflight linter entry point.
 *
 * runValidate(composeSource, ctx) parses the compose once, runs every rule, and
 * returns findings (with editor line positions) sorted most-severe first. Pure and
 * synchronous: the caller pre-fetches any environment context into `ctx`.
 */

import { parseCompose } from './parse';
import { RULES } from './rules';
import { renderEffectiveCompose } from './effective-compose';
import { findingKey } from '../../utils/compose-quick-fix';
import type { ValidateConfig, ValidateContext, ValidateReport, Finding, Severity } from './types';

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warn: 1, info: 2 };

/** The rule catalog as UI/config metadata (id, description, group, default severity). */
export function ruleCatalog(): { id: string; description: string; group: string; defaultSeverity: Severity }[] {
	return RULES.map((r) => ({
		id: r.id,
		description: r.description,
		group: r.group,
		defaultSeverity: r.defaultSeverity
	}));
}

function assemble(findings: Finding[]): ValidateReport {
	// Dedupe by ruleId+line+message so config's schema error and our YAML_PARSE_ERROR
	// don't double up on the same underlying problem.
	const seen = new Set<string>();
	const deduped = findings.filter((f) => {
		const key = findingKey(f);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
	deduped.sort(
		(a, b) =>
			SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
			(a.line ?? 1e9) - (b.line ?? 1e9)
	);
	const counts = { error: 0, warn: 0, info: 0 };
	for (const f of deduped) counts[f.severity]++;
	return { findings: deduped, counts };
}

/**
 * Synchronous, offline lint. Parses the compose locally and runs the rule catalog.
 * This is the fast every-keystroke / edit-time path (no daemon).
 */
export function runValidate(
	composeSource: string,
	ctx: ValidateContext = {},
	config: ValidateConfig = {}
): ValidateReport {
	const parsed = parseCompose(composeSource);
	const findings: Finding[] = [];
	const disabled = new Set(config.disabled ?? []);
	const overrides = config.severity ?? {};

	// A hard YAML/parse error is itself a finding; rules that need `doc` will no-op.
	// (YAML_PARSE_ERROR is not a configurable rule - a file that won't parse is always
	// an error.)
	if (parsed.parseError) {
		findings.push({
			ruleId: 'YAML_PARSE_ERROR',
			severity: 'error',
			message: parsed.parseError.message,
			hint: 'Fix the YAML syntax; nothing else can be checked until it parses.',
			line: parsed.parseError.line
		});
	}

	for (const rule of RULES) {
		if (disabled.has(rule.id)) continue;
		try {
			for (const f of rule.check(parsed, ctx)) {
				// Effective severity: explicit (graded rule) > user override > rule default.
				const severity = f.severity ?? overrides[rule.id] ?? rule.defaultSeverity;
				findings.push({ ...f, severity });
			}
		} catch {
			// A rule must never break the whole report; skip its output on error.
		}
	}

	return assemble(findings);
}

/**
 * Full validate: run `docker compose config` FIRST for authoritative schema/syntax
 * validation (its errors get added), then always run the local rule catalog for the
 * checks config can't do (port collisions, exposure, typos, transport). The rules run
 * against the ORIGINAL source so editor line markers stay accurate (config's output is
 * re-serialized and its lines wouldn't map back). Falls back to a pure local lint when
 * no daemon is reachable. This is the deploy-time / env-online path.
 */
export async function runValidateWithConfig(
	stackName: string,
	composeSource: string,
	ctx: ValidateContext = {},
	dockerHost?: string | null,
	config: ValidateConfig = {},
	envVars?: Record<string, string>
): Promise<ValidateReport> {
	const local = runValidate(composeSource, ctx, config);

	const cfg = await renderEffectiveCompose(stackName, composeSource, dockerHost, envVars);

	// If config produced schema errors, merge them in. If the file already failed to
	// parse locally, prefer config's precise schema message but keep both.
	if (cfg.findings.length > 0) {
		const parsed = parseCompose(composeSource);
		const located = cfg.findings.map((f) => (f.line ? f : locateSchemaError(f, parsed)));
		return assemble([...located, ...local.findings]);
	}
	return local;
}

/**
 * `docker compose config` reports schema errors by dotted key path
 * (`services.api additional properties 'restar' not allowed`) but no line. Recover a
 * line so the finding is clickable / gets an editor marker: map the dotted path to a
 * key path and ask the local position map. Best-effort - returns the finding unchanged
 * when nothing matches.
 */
function locateSchemaError(f: Finding, parsed: ReturnType<typeof parseCompose>): Finding {
	// Pull the leading dotted path (`services.api.ports`) out of the message.
	const pathMatch = /^([a-z_][\w.]*)/i.exec(f.message);
	if (!pathMatch) return f;
	const segs = pathMatch[1].split('.').filter(Boolean);
	// `additional properties 'foo'` -> the offending key sits under that path.
	const badKey = /additional propert(?:y|ies)\s+'([^']+)'/i.exec(f.message)?.[1];
	const keyPath = badKey ? [...segs, badKey] : segs;
	const line = parsed.lineOf(keyPath) ?? parsed.lineOf(segs);
	return line ? { ...f, line } : f;
}

export type { ValidateReport, Finding, ValidateContext, Severity } from './types';
