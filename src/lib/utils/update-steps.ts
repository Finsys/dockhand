/**
 * Shared utilities for update step visualization across:
 * - BatchUpdateModal (manual update from containers grid)
 * - Scheduled container auto-updates
 * - Scheduled environment update checks
 */

import {
	Download,
	Shield,
	Square,
	Trash2,
	Box,
	Play,
	CheckCircle2,
	XCircle,
	ShieldBan,
	Circle,
	Loader2,
	ShieldAlert,
	ShieldCheck,
	ShieldOff,
	ShieldX
} from 'lucide-svelte';
import type { ComponentType } from 'svelte';
import type { VulnerabilityCriteria } from '$lib/server/db';
import { m } from '$lib/paraglide/messages.js';

// Step types for update process
export type StepType =
	| 'pulling'
	| 'scanning'
	| 'stopping'
	| 'removing'
	| 'creating'
	| 'starting'
	| 'done'
	| 'failed'
	| 'blocked'
	| 'checked'
	| 'skipped'
	| 'updated';

// Get icon component for a step
export function getStepIcon(step: StepType): ComponentType {
	switch (step) {
		case 'pulling':
			return Download;
		case 'scanning':
			return Shield;
		case 'stopping':
			return Square;
		case 'removing':
			return Trash2;
		case 'creating':
			return Box;
		case 'starting':
			return Play;
		case 'done':
		case 'updated':
			return CheckCircle2;
		case 'failed':
			return XCircle;
		case 'blocked':
			return ShieldBan;
		case 'checked':
		case 'skipped':
			return Circle;
		default:
			return Loader2;
	}
}

// Get human-readable label for a step
export function getStepLabel(step: StepType): string {
	switch (step) {
		case 'pulling':
			return m.updatesteps_step_pulling();
		case 'scanning':
			return m.updatesteps_step_scanning();
		case 'stopping':
			return m.updatesteps_step_stopping();
		case 'removing':
			return m.updatesteps_step_removing();
		case 'creating':
			return m.updatesteps_step_creating();
		case 'starting':
			return m.updatesteps_step_starting();
		case 'done':
			return m.updatesteps_step_done();
		case 'updated':
			return m.updatesteps_step_updated();
		case 'failed':
			return m.updatesteps_step_failed();
		case 'blocked':
			return m.updatesteps_step_blocked();
		case 'checked':
			return m.updatesteps_step_checked();
		case 'skipped':
			return m.updatesteps_step_skipped();
		default:
			return step;
	}
}

// Get color classes for a step
export function getStepColor(step: StepType): string {
	switch (step) {
		case 'done':
		case 'updated':
			return 'text-green-600 dark:text-green-400';
		case 'failed':
			return 'text-red-600 dark:text-red-400';
		case 'blocked':
			return 'text-amber-600 dark:text-amber-400';
		case 'scanning':
			return 'text-purple-600 dark:text-purple-400';
		case 'checked':
		case 'skipped':
			return 'text-muted-foreground';
		default:
			return 'text-blue-600 dark:text-blue-400';
	}
}

// Vulnerability criteria labels (message functions, called when rendered)
export const vulnerabilityCriteriaLabels: Record<VulnerabilityCriteria, () => string> = {
	never: m.vulncriteria_never,
	any: m.vulncriteria_badge_any,
	critical_high: m.vulncriteria_critical_high,
	critical: m.vulncriteria_critical,
	more_than_current: m.vulncriteria_more_than_current
};

// Vulnerability criteria icons with colors and titles (title is a message function)
export const vulnerabilityCriteriaIcons: Record<
	VulnerabilityCriteria,
	{ component: ComponentType; class: string; title: () => string }
> = {
	never: { component: ShieldOff, class: 'w-3.5 h-3.5 text-muted-foreground', title: m.updatesteps_criteria_title_never },
	any: { component: ShieldAlert, class: 'w-3.5 h-3.5 text-amber-500', title: m.updatesteps_criteria_title_any },
	critical_high: { component: ShieldX, class: 'w-3.5 h-3.5 text-orange-500', title: m.updatesteps_criteria_title_critical_high },
	critical: { component: ShieldX, class: 'w-3.5 h-3.5 text-red-500', title: m.updatesteps_criteria_title_critical },
	more_than_current: { component: Shield, class: 'w-3.5 h-3.5 text-blue-500', title: m.updatesteps_criteria_title_more_than_current }
};

// Get badge variant based on criteria severity
export function getCriteriaBadgeClass(criteria: VulnerabilityCriteria): string {
	switch (criteria) {
		case 'any':
			return 'bg-red-500/10 text-red-600 border-red-500/30';
		case 'critical_high':
			return 'bg-orange-500/10 text-orange-600 border-orange-500/30';
		case 'critical':
			return 'bg-amber-500/10 text-amber-600 border-amber-500/30';
		case 'more_than_current':
			return 'bg-blue-500/10 text-blue-600 border-blue-500/30';
		default:
			return 'bg-slate-500/10 text-slate-600 border-slate-500/30';
	}
}
