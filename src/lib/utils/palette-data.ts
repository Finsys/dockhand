// Pure row mappers for the command palette. The /api/containers and /api/stacks
// endpoints are per-environment and return camelCase rows; the palette stamps the
// env identity (from the loop) onto each row. Extracted (like palette-filter) so the
// exact field mapping that once regressed to Docker PascalCase is unit-testable.

import { containerDisplayName } from './container-display-name';

export interface PaletteEnv {
	id: number;
	name: string;
	icon?: string;
}

export interface ContainerRow {
	id: string;
	name: string;
	/** `dockhand.name` label or the real name; shown as the row label. */
	displayName: string;
	state: string;
	image: string;
	envId: number;
	envName: string;
	envIcon: string;
}

export interface StackRow {
	id: string;
	name: string;
	icon?: string | null;
	envId: number;
	envName: string;
	envIcon: string;
}

/** Map one env's /api/containers rows (camelCase {id,name,state,image}) to palette rows. */
export function mapContainerRows(list: unknown, env: PaletteEnv): ContainerRow[] {
	if (!Array.isArray(list)) return [];
	return list.map((c: any) => ({
		id: c.id,
		name: c.name,
		displayName: containerDisplayName(c),
		state: c.state,
		image: c.image,
		envId: env.id,
		envName: env.name,
		envIcon: env.icon || 'globe'
	}));
}

/** Map one env's /api/stacks rows to palette rows (id namespaced by env). */
export function mapStackRows(list: unknown, env: PaletteEnv): StackRow[] {
	if (!Array.isArray(list)) return [];
	return list.map((s: any) => ({
		id: `${env.id}:${s.name}`,
		name: s.name,
		icon: s.icon ?? null,
		envId: env.id,
		envName: env.name,
		envIcon: env.icon || 'globe'
	}));
}

/**
 * Flatten per-group arrays by taking one from each group in turn
 * (g0[0], g1[0], ..., g0[1], g1[1], ...). The palette caps its empty view, so
 * interleaving per environment surfaces variety instead of filling the cap with
 * one environment's rows (and their copies when environments share a daemon).
 */
export function roundRobin<T>(groups: T[][]): T[] {
	const out: T[] = [];
	const max = Math.max(0, ...groups.map((g) => g.length));
	for (let i = 0; i < max; i++) {
		for (const g of groups) {
			if (i < g.length) out.push(g[i]);
		}
	}
	return out;
}
