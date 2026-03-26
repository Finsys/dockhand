<script lang="ts">
	import { Label } from '$lib/components/ui/label';
	import { TogglePill } from '$lib/components/ui/toggle-pill';
	import CronEditor from '$lib/components/cron-editor.svelte';
	import VulnerabilityCriteriaSelector, { type VulnerabilityCriteria } from '$lib/components/VulnerabilityCriteriaSelector.svelte';
	import { currentEnvironment } from '$lib/stores/environment';
	import { Ship, Cable, ExternalLink, AlertTriangle, Info, Clock, ShieldCheck, Ban } from 'lucide-svelte';
	import { ToggleGroup } from '$lib/components/ui/toggle-pill';
	import type { SystemContainerType } from '$lib/types';

	interface Props {
		enabled: boolean;
		cronExpression: string;
		vulnerabilityCriteria: VulnerabilityCriteria;
		minimumImageAgeDays: number | null;
		bypassAgeForSecurityFixes: boolean | null;
		excludedFromEnvUpdate: boolean;
		systemContainer?: SystemContainerType | null;
		onenablechange?: (enabled: boolean) => void;
		oncronchange?: (cron: string) => void;
		oncriteriachange?: (criteria: VulnerabilityCriteria) => void;
		onagechange?: (days: number | null) => void;
		onbypasschange?: (bypass: boolean | null) => void;
		onexcludedchange?: (excluded: boolean) => void;
	}

	let {
		enabled = $bindable(),
		cronExpression = $bindable(),
		vulnerabilityCriteria = $bindable(),
		minimumImageAgeDays = $bindable(),
		bypassAgeForSecurityFixes = $bindable(),
		excludedFromEnvUpdate = $bindable(),
		systemContainer = null,
		onenablechange,
		oncronchange,
		oncriteriachange,
		onagechange,
		onbypasschange,
		onexcludedchange
	}: Props = $props();

	function handleAgeChange(e: Event) {
		const val = (e.target as HTMLInputElement).value;
		if (val === '') {
			minimumImageAgeDays = null;
			onagechange?.(null);
		} else {
			const num = parseInt(val);
			if (!isNaN(num) && num >= 0) {
				minimumImageAgeDays = num;
				onagechange?.(num);
			}
		}
	}

	let envHasScanning = $state(false);

	// Check if environment has scanning enabled
	$effect(() => {
		if (enabled) {
			checkScannerSettings();
		}
	});

	async function checkScannerSettings() {
		try {
			const envParam = $currentEnvironment ? `env=${$currentEnvironment.id}&` : '';
			const response = await fetch(`/api/settings/scanner?${envParam}settingsOnly=true`);
			if (response.ok) {
				const data = await response.json();
				envHasScanning = data.settings.scanner !== 'none';
			}
		} catch (err) {
			console.error('Failed to fetch scanner settings:', err);
			envHasScanning = false;
		}
	}
</script>

{#if systemContainer}
	<!-- System container - show informational message instead of settings -->
	<div class="rounded-lg border border-blue-500/30 bg-blue-500/5 p-3">
		<div class="flex items-start gap-2">
			<AlertTriangle class="w-4 h-4 text-blue-500 mt-0.5 shrink-0" />
			<div class="space-y-2 text-xs">
				{#if systemContainer === 'dockhand'}
					<p class="font-medium text-blue-600 dark:text-blue-400">Auto-updates not available</p>
					<p class="text-muted-foreground">
						Dockhand cannot update itself. To update, run on the host:
					</p>
					<code class="block bg-muted rounded px-2 py-1 font-mono text-2xs">
						docker compose pull && docker compose up -d
					</code>
				{:else}
					<p class="font-medium text-blue-600 dark:text-blue-400">Auto-updates not available</p>
					<p class="text-muted-foreground">
						Hawser agents must be updated on their remote host.
					</p>
					<a
						href="https://github.com/Finsys/hawser"
						target="_blank"
						rel="noopener noreferrer"
						class="text-primary hover:underline flex items-center gap-1"
					>
						<ExternalLink class="w-3 h-3" />
						View update instructions on GitHub
					</a>
				{/if}
			</div>
		</div>
	</div>
{:else}
	<div class="space-y-3">
		<div class="flex items-center gap-3">
			<Label class="text-xs font-normal">Enable automatic image updates</Label>
			<TogglePill
				bind:checked={enabled}
				onchange={(value) => onenablechange?.(value)}
			/>
		</div>

		{#if enabled}
			<CronEditor
				value={cronExpression}
				onchange={(cron) => {
					cronExpression = cron;
					oncronchange?.(cron);
				}}
			/>

			{#if envHasScanning}
				<div class="space-y-1.5">
					<Label class="text-xs font-medium">Vulnerability criteria</Label>
					<VulnerabilityCriteriaSelector
						bind:value={vulnerabilityCriteria}
						onchange={(v) => oncriteriachange?.(v)}
					/>
					<p class="text-xs text-muted-foreground">
						Block auto-updates if new image has vulnerabilities matching this criteria
					</p>
				</div>
			{/if}

			<div class="space-y-1.5">
				<div class="flex items-center gap-2">
					<Clock class="w-3.5 h-3.5 text-blue-500" />
					<Label class="text-xs font-medium">Minimum image age (days)</Label>
				</div>
				<input
					type="number"
					min="0"
					max="365"
					placeholder="Inherit from environment"
					class="w-full h-8 rounded-md border border-input bg-background px-3 py-1 text-xs"
					value={minimumImageAgeDays ?? ''}
					oninput={handleAgeChange}
				/>
				<p class="text-xs text-muted-foreground">
					Leave empty to use environment default. Set to 0 to disable for this container.
				</p>
			</div>

			{#if minimumImageAgeDays !== 0 && envHasScanning}
				<div class="space-y-1.5">
					<div class="flex items-center gap-2">
						<ShieldCheck class="w-3.5 h-3.5 text-emerald-500" />
						<Label class="text-xs font-medium">Bypass age gate for security fixes</Label>
					</div>
					<ToggleGroup
						value={bypassAgeForSecurityFixes === null ? 'inherit' : bypassAgeForSecurityFixes ? 'yes' : 'no'}
						options={[
							{ value: 'inherit', label: 'Inherit' },
							{ value: 'yes', label: 'Yes' },
							{ value: 'no', label: 'No' }
						]}
						onchange={(val) => {
							const mapped = val === 'inherit' ? null : val === 'yes';
							bypassAgeForSecurityFixes = mapped;
							onbypasschange?.(mapped);
						}}
					/>
				</div>
			{/if}
		{/if}

		<!-- Env-level exclusion — shown even when per-container auto-update is off -->
		<div class="flex items-center gap-2 pt-2 border-t">
			<Ban class="w-3.5 h-3.5 text-amber-500" />
			<Label class="text-xs font-normal flex-1">Exclude from environment auto-updates</Label>
			<TogglePill
				bind:checked={excludedFromEnvUpdate}
				onchange={(value) => onexcludedchange?.(value)}
			/>
		</div>
		{#if excludedFromEnvUpdate}
			<p class="text-xs text-muted-foreground">
				This container will be skipped during environment-level scheduled updates. Update checks still show availability.
			</p>
		{/if}
	</div>
{/if}
