/**
 * Compose Validate - shared types.
 *
 * A preflight linter for compose files: it parses the compose, runs a catalog of
 * pure rules, and returns findings that carry a 1-based `line` so the editor can
 * place inline markers (underline + gutter icon + tooltip), IDE-style.
 */

export type Severity = 'error' | 'warn' | 'info';

// The fix shape + applier live in ../../utils so both the server (emit) and the stack
// editor (apply) share one definition. Use a relative path, not the $lib alias: the bun
// unit runner has no $lib alias, so a value import from here would break CI.
export type { QuickFix } from '../../utils/compose-quick-fix';
import type { QuickFix } from '../../utils/compose-quick-fix';

export interface Finding {
	/** Stable rule id, e.g. 'DUPLICATE_HOST_PORT'. */
	ruleId: string;
	severity: Severity;
	/** Human message shown in the tooltip / panel. */
	message: string;
	/** Optional actionable hint ("bind to 127.0.0.1 or use a reverse proxy"). */
	hint?: string;
	/** Service the finding belongs to, when service-scoped. */
	service?: string;
	/** 1-based line in the ORIGINAL source for the editor marker. Absent => file-level. */
	line?: number;
	/** A one-click deterministic fix, when the rule can offer one unambiguously. */
	fix?: QuickFix;
	/** Plain-language description of what the fix does (button tooltip). */
	fixDescription?: string;
}

/**
 * Parsed compose plus a key-path -> line resolver. Built once by parseCompose and
 * passed to every rule so a rule can attach a precise line without re-parsing.
 */
export interface ParsedCompose {
	/** The plain-object compose (js-yaml style), or null if the YAML failed to parse. */
	doc: Record<string, unknown> | null;
	/** A hard parse error (invalid YAML / duplicate key), if any. */
	parseError?: { message: string; line?: number };
	/**
	 * Resolve the 1-based source line for a key path, e.g.
	 * lineOf(['services','web','image']). Returns undefined if the path has no node.
	 */
	lineOf(path: (string | number)[]): number | undefined;
	/**
	 * The 0-based indentation of the KEY at a mapping path (column - 1), so an
	 * insert-fix can match the file's own indent width. undefined if unresolved.
	 */
	indentOf(path: (string | number)[]): number | undefined;
	/**
	 * The 0-based column where the VALUE node at a path begins, so a replace-fix can
	 * anchor to the exact token rather than the first substring on the line. undefined
	 * if unresolved.
	 */
	columnOf(path: (string | number)[]): number | undefined;
}

/**
 * Context a rule may consult beyond the compose itself. All optional: pure/offline
 * rules ignore it; context-aware rules (cross-stack port collisions, missing external
 * networks/volumes, secret-provider awareness) read it. Built by context.ts from the
 * target environment; undefined when running offline (e.g. edit-time before a bind).
 */
export interface ValidateContext {
	/** Host ports already published by OTHER stacks/containers on the target env. */
	usedHostPorts?: Set<number>;
	/** For each used host port, the container name that publishes it (for the message). */
	hostPortOwners?: Map<number, string>;
	/** Names of networks that already exist on the target env (for external: true). */
	existingNetworks?: Set<string>;
	/** Names of volumes that already exist on the target env (for external: true). */
	existingVolumes?: Set<string>;
	/** Container names already in use on the target env (for container_name collisions). */
	existingContainerNames?: Set<string>;
	/** Env-var names the bound secret provider can supply (for SENSITIVE_ENV). */
	providerKeys?: Set<string>;
	/** This stack's own name, so cross-stack checks can exclude self. */
	selfStackName?: string;
}

/**
 * What a rule's check returns: a finding whose `severity` is OPTIONAL. Normally a rule
 * omits it and the engine stamps the effective severity (default or user override). A
 * rule MAY set severity itself when it is intrinsically graded (e.g. docker.sock
 * rw=error vs ro=warn); the engine respects an explicitly-set severity.
 */
export type RuleFinding = Omit<Finding, 'severity'> & { severity?: Severity };

/** A rule's check: a pure function (parsed compose, context) -> findings. */
export type RuleCheck = (parsed: ParsedCompose, ctx: ValidateContext) => RuleFinding[];

/**
 * A rule is a self-contained plugin. Adding a new rule = write one RuleDefinition and
 * register it in the catalog - nothing else. `id` is stable (used in config + the UI),
 * `defaultSeverity` is the out-of-the-box level, `check` is the pure logic.
 */
export interface RuleDefinition {
	/** Stable, uppercase-snake id, e.g. 'DUPLICATE_HOST_PORT'. Used in config + UI. */
	id: string;
	/** One-line human description shown in the rules settings UI. */
	description: string;
	/** Severity applied unless the user overrides it (or the check sets its own). */
	defaultSeverity: Severity;
	/** Group for the settings UI (security / correctness / reliability / schema). */
	group: 'security' | 'correctness' | 'reliability' | 'schema';
	/** The pure check. */
	check: RuleCheck;
}

/**
 * User configuration for the rule set. `disabled` turns a rule off entirely;
 * `severity` overrides a rule's level. Keyed by rule id. Stored per-stack (and/or a
 * global default) and passed into the engine. Absent = every rule at its default.
 */
export interface ValidateConfig {
	disabled?: string[];
	severity?: Record<string, Severity>;
}

export interface ValidateReport {
	findings: Finding[];
	counts: { error: number; warn: number; info: number };
}
