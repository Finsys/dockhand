<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { CircleX, TriangleAlert, Info, CheckCircle2, ArrowRight, Loader2, RefreshCw, X, ChevronDown, Wand2 } from 'lucide-svelte';
	import { slide } from 'svelte/transition';
	import { findingKey, type QuickFix } from '$lib/utils/compose-quick-fix';

	export interface ValidateFinding {
		ruleId: string;
		severity: 'error' | 'warn' | 'info';
		message: string;
		hint?: string;
		service?: string;
		line?: number;
		fix?: QuickFix;
		fixDescription?: string;
	}
	export interface ValidateReport {
		findings: ValidateFinding[];
		counts: { error: number; warn: number; info: number };
	}

	interface Props {
		report: ValidateReport | null;
		loading?: boolean;
		error?: string | null;
		activeLine?: number | null;
		onClose: () => void;
		onJumpToLine?: (line: number) => void;
		onRevalidate?: () => void;
		onApplyFix?: (finding: ValidateFinding) => void;
	}
	let { report, loading = false, error = null, activeLine = null, onClose, onJumpToLine, onRevalidate, onApplyFix }: Props = $props();

	const SEV = {
		error: { label: 'Errors', Icon: CircleX, color: 'var(--sev-error)', bg: 'rgba(239,68,68,0.12)' },
		warn: { label: 'Warnings', Icon: TriangleAlert, color: 'var(--sev-warn)', bg: 'rgba(245,158,11,0.12)' },
		info: { label: 'Suggestions', Icon: Info, color: 'var(--sev-info)', bg: 'rgba(59,130,246,0.12)' }
	} as const;

	const findings = $derived(report?.findings ?? []);
	const counts = $derived(report?.counts ?? { error: 0, warn: 0, info: 0 });
	const total = $derived(counts.error + counts.warn + counts.info);
	const clean = $derived(!loading && !error && report !== null && total === 0);
	const grouped = $derived(
		(['error', 'warn', 'info'] as const)
			.map((sev) => ({ sev, items: findings.filter((f) => f.severity === sev) }))
			.filter((g) => g.items.length > 0)
	);

	// Collapsed severity groups (all expanded by default).
	let collapsed = $state<Record<'error' | 'warn' | 'info', boolean>>({ error: false, warn: false, info: false });
	function toggleGroup(sev: 'error' | 'warn' | 'info') {
		collapsed = { ...collapsed, [sev]: !collapsed[sev] };
	}

	// Explicitly scroll the finding for a line into view (called by the parent when a
	// gutter icon is clicked - NOT on every re-validate, which would make the list jump).
	let bodyEl = $state<HTMLDivElement | null>(null);
	export function scrollToFinding(line: number) {
		const target = findings.find((f) => f.line === line);
		if (target && collapsed[target.severity]) {
			collapsed = { ...collapsed, [target.severity]: false };
		}
		requestAnimationFrame(() => {
			bodyEl?.querySelector(`[data-line="${line}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
		});
	}
</script>

<div class="cvp">
	<!-- Header: title + count chips inline -->
	<div class="cvp-header">
		<div class="cvp-title">Compose Validate</div>
		{#if !loading && !error && report}
			<div class="cvp-chips">
				{#each ['error', 'warn', 'info'] as const as sev}
					{@const c = counts[sev]}
					{@const SIcon = SEV[sev].Icon}
					<div class="cvp-chip" class:cvp-chip-muted={c === 0} style="--chip-color: {SEV[sev].color}; --chip-bg: {SEV[sev].bg}">
						<SIcon class="h-3 w-3" />
						<span class="cvp-chip-count">{c}</span>
					</div>
				{/each}
			</div>
		{/if}
		<div class="cvp-header-actions">
			{#if onRevalidate}
				<button class="cvp-iconbtn" title="Re-check" onclick={onRevalidate} disabled={loading}>
					{#if loading}<Loader2 class="h-4 w-4 animate-spin" />{:else}<RefreshCw class="h-4 w-4" />{/if}
				</button>
			{/if}
			<button class="cvp-iconbtn" title="Close panel" onclick={onClose}><X class="h-4 w-4" /></button>
		</div>
	</div>

	<!-- Body -->
	<div class="cvp-body" bind:this={bodyEl}>
		{#if loading}
			<div class="cvp-center"><Loader2 class="h-5 w-5 animate-spin text-muted-foreground" /><p>Validating...</p></div>
		{:else if error}
			<div class="cvp-center cvp-error-state"><CircleX class="h-5 w-5" /><p>{error}</p></div>
		{:else if clean}
			<div class="cvp-center cvp-clean">
				<div class="cvp-clean-badge"><CheckCircle2 class="h-7 w-7" /></div>
				<p class="cvp-clean-title">No problems found</p>
				<p class="cvp-clean-sub">Passes every enabled check.</p>
			</div>
		{:else}
			{#each grouped as group (group.sev)}
				{@const GIcon = SEV[group.sev].Icon}
				<div class="cvp-group">
					<button type="button" class="cvp-group-head" style="--chip-color: {SEV[group.sev].color}" onclick={() => toggleGroup(group.sev)}>
						<ChevronDown class="cvp-chevron h-3.5 w-3.5 {collapsed[group.sev] ? '-rotate-90' : ''}" />
						<GIcon class="h-3.5 w-3.5" />
						<span>{SEV[group.sev].label}</span>
						<span class="cvp-group-count">{group.items.length}</span>
					</button>
					{#if !collapsed[group.sev]}
					{#each group.items as f (findingKey(f))}
							<div
								class="cvp-finding"
								class:cvp-finding-active={activeLine != null && f.line === activeLine}
								style="--chip-color: {SEV[f.severity].color}"
								data-line={f.line ?? undefined}
								transition:slide={{ duration: 200 }}
							>
								<div class="cvp-finding-bar"></div>
								<div class="cvp-finding-body">
									<div class="cvp-finding-top">
										<span class="cvp-rule">{f.ruleId}</span>
										{#if f.line}<span class="cvp-line">L{f.line}<ArrowRight class="h-3 w-3" /></span>{/if}
										{#if f.fix && onApplyFix}
											<button
												type="button"
												class="cvp-fix"
												title={f.fixDescription ?? 'Apply quick fix'}
												onclick={() => onApplyFix?.(f)}
											>
												<Wand2 class="h-3 w-3" />
												Fix
											</button>
										{/if}
									</div>
									<button
										type="button"
										class="cvp-finding-jump"
										onclick={() => f.line && onJumpToLine?.(f.line)}
										disabled={!f.line}
									>
										<p class="cvp-message">{f.message}</p>
										{#if f.hint}<p class="cvp-hint">{f.hint}</p>{/if}
									</button>
								</div>
							</div>
					{/each}
					{/if}
				</div>
			{/each}
		{/if}
	</div>
</div>

<style>
	.cvp {
		--sev-error: #ef4444;
		--sev-warn: #f59e0b;
		--sev-info: #3b82f6;
		display: flex;
		flex-direction: column;
		height: 100%;
		background: hsl(var(--card));
		border: 1px solid hsl(var(--border));
		border-radius: 0.5rem;
		overflow: hidden;
	}
	.cvp-header {
		display: flex; align-items: center; gap: 0.5rem;
		padding: 0.6rem 0.75rem;
		border-bottom: 1px solid hsl(var(--border));
	}
	.cvp-title { font-size: 0.82rem; font-weight: 650; line-height: 1.1; white-space: nowrap; }
	.cvp-chips { display: flex; gap: 0.3rem; margin-left: 0.15rem; }
	.cvp-header-actions { display: flex; gap: 0.15rem; margin-left: auto; }
	.cvp-iconbtn {
		display: flex; align-items: center; justify-content: center;
		width: 1.6rem; height: 1.6rem; border-radius: 0.35rem;
		color: hsl(var(--muted-foreground)); flex-shrink: 0;
		transition: background 0.12s ease, color 0.12s ease;
	}
	.cvp-iconbtn:hover { background: hsl(var(--muted)); color: hsl(var(--foreground)); }
	.cvp-iconbtn:disabled { opacity: 0.5; }

	.cvp-chip {
		display: inline-flex; align-items: center; gap: 0.3rem;
		padding: 0.2rem 0.5rem; border-radius: 999px; font-size: 0.72rem;
		color: var(--chip-color); background: var(--chip-bg);
		border: 1px solid color-mix(in srgb, var(--chip-color) 30%, transparent);
	}
	.cvp-chip-muted { opacity: 0.4; filter: grayscale(0.6); }
	.cvp-chip-count { font-weight: 700; font-variant-numeric: tabular-nums; }

	.cvp-body { flex: 1; overflow-y: auto; padding: 0.5rem 0.6rem 0.75rem; }
	.cvp-center {
		display: flex; flex-direction: column; align-items: center; justify-content: center;
		gap: 0.6rem; padding: 2.5rem 0.75rem; color: hsl(var(--muted-foreground));
		text-align: center; font-size: 0.8rem;
	}
	.cvp-error-state { color: var(--sev-error); }
	.cvp-clean-badge {
		display: flex; align-items: center; justify-content: center;
		width: 3rem; height: 3rem; border-radius: 999px;
		background: rgba(34,197,94,0.14); color: #22c55e;
	}
	.cvp-clean-title { font-size: 0.9rem; font-weight: 600; color: hsl(var(--foreground)); }
	.cvp-clean-sub { font-size: 0.76rem; }

	.cvp-group { margin-top: 0.7rem; }
	.cvp-group:first-child { margin-top: 0.15rem; }
	.cvp-group-head {
		display: flex; align-items: center; gap: 0.35rem; width: 100%;
		font-size: 0.68rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em;
		color: var(--chip-color); margin-bottom: 0.35rem;
		padding: 0.15rem 0.2rem; border-radius: 0.3rem;
		transition: background 0.12s ease;
	}
	.cvp-group-head:hover { background: hsl(var(--muted) / 0.5); }
	:global(.cvp-chevron) { transition: transform 0.15s ease; flex-shrink: 0; opacity: 0.8; }
	.cvp-group-count {
		font-variant-numeric: tabular-nums;
		background: color-mix(in srgb, var(--chip-color) 15%, transparent);
		border-radius: 999px; padding: 0 0.35rem; font-size: 0.66rem;
	}

	.cvp-finding {
		display: flex; align-items: stretch; width: 100%; text-align: left;
		background: hsl(var(--background));
		border: 1px solid hsl(var(--border));
		border-radius: 0.45rem; margin-bottom: 0.35rem; overflow: hidden;
		transition: border-color 0.12s ease, background 0.12s ease;
	}
	.cvp-finding:hover {
		border-color: color-mix(in srgb, var(--chip-color) 55%, hsl(var(--border)));
	}
	.cvp-finding-active {
		border-color: var(--chip-color) !important;
		background: color-mix(in srgb, var(--chip-color) 8%, hsl(var(--background)));
	}
	.cvp-finding-bar { width: 3px; background: var(--chip-color); flex-shrink: 0; }
	.cvp-finding-body { padding: 0.5rem 0.65rem; min-width: 0; flex: 1; display: flex; flex-direction: column; }
	.cvp-finding-jump {
		text-align: left; background: transparent; transition: transform 0.06s ease;
	}
	.cvp-finding-jump:not(:disabled):hover { cursor: pointer; }
	.cvp-finding-jump:not(:disabled):active { transform: translateY(1px); }
	.cvp-finding-jump:disabled { cursor: default; }
	.cvp-fix {
		display: inline-flex; align-items: center; gap: 0.2rem; flex-shrink: 0;
		margin-left: 0.4rem; padding: 0.12rem 0.4rem; border-radius: 0.3rem;
		font-size: 0.66rem; font-weight: 600;
		color: hsl(var(--muted-foreground));
		background: hsl(var(--muted));
		border: 1px solid hsl(var(--border));
		transition: background 0.12s ease, color 0.12s ease;
	}
	.cvp-fix:hover { background: hsl(var(--accent)); color: hsl(var(--foreground)); cursor: pointer; }
	.cvp-fix:active { transform: translateY(1px); }
	.cvp-finding-top { display: flex; align-items: center; gap: 0.4rem; margin-bottom: 0.2rem; }
	.cvp-rule {
		font-family: ui-monospace, monospace; font-size: 0.64rem; font-weight: 600;
		color: var(--chip-color);
		background: color-mix(in srgb, var(--chip-color) 12%, transparent);
		padding: 0.03rem 0.35rem; border-radius: 0.28rem;
	}
	.cvp-line {
		display: inline-flex; align-items: center; gap: 0.1rem;
		font-size: 0.66rem; color: hsl(var(--muted-foreground)); margin-left: auto;
	}
	.cvp-message { font-size: 0.78rem; color: hsl(var(--foreground)); line-height: 1.3; }
	.cvp-hint { font-size: 0.72rem; color: hsl(var(--muted-foreground)); margin-top: 0.15rem; line-height: 1.3; }
</style>
