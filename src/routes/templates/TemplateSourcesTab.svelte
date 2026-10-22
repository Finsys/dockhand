<script lang="ts">
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { TogglePill } from '$lib/components/ui/toggle-pill';
	import { Plus, Trash2, Globe, Loader2, CheckCircle2, XCircle, ShieldCheck } from 'lucide-svelte';
	import { toast } from 'svelte-sonner';
	import type { TemplateSource } from '$lib/server/templates';
	import { m } from '$lib/paraglide/messages.js';

	interface Props {
		onSourcesChanged: () => void;
	}

	let { onSourcesChanged }: Props = $props();

	let sources = $state<TemplateSource[]>([]);
	let loading = $state(true);
	let addingNew = $state(false);
	let newName = $state('');
	let newUrl = $state('');
	let validating = $state(false);
	let validationResults = $state<Map<string, { ok: boolean; count?: number; error?: string }>>(new Map());

	async function loadSources() {
		loading = true;
		try {
			const response = await fetch('/api/templates/sources');
			if (response.ok) {
				sources = await response.json();
			}
		} catch {
			toast.error(m.templates_sources_toast_load_failed());
		} finally {
			loading = false;
		}
	}

	async function toggleSource(source: TemplateSource) {
		const newEnabled = !source.enabled;
		source.enabled = newEnabled;
		sources = sources;
		try {
			const response = await fetch('/api/templates/sources', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ id: source.id, enabled: newEnabled })
			});
			if (!response.ok) throw new Error();
			onSourcesChanged();
		} catch {
			source.enabled = !newEnabled;
			sources = sources;
			toast.error(m.templates_sources_toast_update_failed());
		}
	}

	async function removeSource(source: TemplateSource) {
		try {
			const response = await fetch(`/api/templates/sources?id=${source.id}`, { method: 'DELETE' });
			if (!response.ok) throw new Error();
			sources = sources.filter(s => s.id !== source.id);
			toast.success(m.templates_sources_toast_removed());
			onSourcesChanged();
		} catch {
			toast.error(m.templates_sources_toast_remove_failed());
		}
	}

	async function addSource() {
		if (!newName.trim() || !newUrl.trim()) return;
		try {
			const response = await fetch('/api/templates/sources', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: newName.trim(), url: newUrl.trim() })
			});
			if (!response.ok) throw new Error();
			const newSource = await response.json();
			sources = [...sources, newSource];
			newName = '';
			newUrl = '';
			addingNew = false;
			toast.success(m.templates_sources_toast_added());
			onSourcesChanged();
		} catch {
			toast.error(m.templates_sources_toast_add_failed());
		}
	}

	async function validateAllSources() {
		validating = true;
		validationResults = new Map();
		let failedCount = 0;

		const checks = sources.map(async (source) => {
			const key = source.sourceId;
			try {
				const response = await fetch(source.url, {
					signal: AbortSignal.timeout(15000)
				});
				if (!response.ok) {
					validationResults.set(key, { ok: false, error: `HTTP ${response.status}` });
					failedCount++;
					return;
				}
				const data = await response.json();
				const templates = Array.isArray(data) ? data : (data.templates || []);
				validationResults.set(key, { ok: true, count: templates.length });
			} catch (error) {
				const msg = error instanceof Error ? error.message : m.templates_sources_connection_failed();
				validationResults.set(key, { ok: false, error: msg });
				failedCount++;
			}
		});

		await Promise.allSettled(checks);
		validationResults = new Map(validationResults);
		validating = false;

		if (failedCount > 0) {
			toast.warning(m.templates_sources_toast_validation_failed({ count: failedCount }));
		} else {
			toast.success(m.templates_sources_toast_all_reachable());
		}
	}

	async function disableInactive() {
		let disabled = 0;
		for (const source of sources) {
			const result = validationResults.get(source.sourceId);
			if (result && !result.ok && source.enabled) {
				await fetch('/api/templates/sources', {
					method: 'PUT',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ id: source.id, enabled: false })
				});
				source.enabled = false;
				disabled++;
			}
		}
		sources = sources;
		if (disabled > 0) {
			toast.success(m.templates_sources_toast_disabled_inactive({ count: disabled }));
			onSourcesChanged();
		}
	}

	$effect(() => {
		loadSources();
	});
</script>

<div class="space-y-4 max-w-3xl">
	<div class="flex items-center justify-between">
		<p class="text-sm text-muted-foreground">
			{m.templates_sources_intro()}
		</p>
		<div class="flex items-center gap-2">
			<Button size="sm" variant="outline" onclick={validateAllSources} disabled={validating}>
				{#if validating}
					<Loader2 class="w-3.5 h-3.5 mr-1.5 animate-spin" />
					{m.templates_sources_validating()}
				{:else}
					<ShieldCheck class="w-3.5 h-3.5 mr-1.5" />
					{m.templates_sources_validate()}
				{/if}
			</Button>
			{#if validationResults.size > 0 && [...validationResults.values()].some(v => !v.ok)}
				<Button size="sm" variant="outline" onclick={disableInactive}>
					<XCircle class="w-3.5 h-3.5 mr-1.5" />
					{m.templates_sources_disable_inactive()}
				</Button>
			{/if}
			<Button size="sm" onclick={() => addingNew = !addingNew}>
				<Plus class="w-3.5 h-3.5 mr-1.5" />
				{m.templates_sources_add_source()}
			</Button>
		</div>
	</div>

	{#if addingNew}
		<Card.Root class="gap-0 py-0 border-dashed border-primary/50">
			<Card.Content class="p-3">
				<div class="flex items-end gap-3">
					<div class="flex-1 space-y-1">
						<label for="new-source-name" class="text-xs font-medium text-muted-foreground">{m.templates_sources_name_label()}</label>
						<Input id="new-source-name" bind:value={newName} placeholder={m.templates_sources_name_placeholder()} class="h-8 text-sm" />
					</div>
					<div class="flex-[2] space-y-1">
						<label for="new-source-url" class="text-xs font-medium text-muted-foreground">{m.templates_sources_url_label()}</label>
						<Input id="new-source-url" bind:value={newUrl} placeholder="https://example.com/templates.json" class="h-8 text-sm" />
					</div>
					<Button size="sm" onclick={addSource} disabled={!newName.trim() || !newUrl.trim()}>{m.templates_sources_add()}</Button>
					<Button size="sm" variant="ghost" onclick={() => addingNew = false}>{m.templates_sources_cancel()}</Button>
				</div>
			</Card.Content>
		</Card.Root>
	{/if}

	{#if loading}
		<div class="flex items-center justify-center py-8 text-muted-foreground">
			<Loader2 class="w-5 h-5 animate-spin mr-2" />
			{m.templates_sources_loading()}
		</div>
	{:else}
		<div class="space-y-2">
			{#each sources as source (source.id)}
				{@const validation = validationResults.get(source.sourceId)}
				<Card.Root class="gap-0 py-0">
					<Card.Content class="py-3 px-4">
						<div class="flex items-center gap-4">
							<div class="w-8 h-8 rounded-md bg-muted flex items-center justify-center flex-shrink-0">
								{#if validation}
									{#if validation.ok}
										<CheckCircle2 class="w-4 h-4 text-emerald-500" />
									{:else}
										<XCircle class="w-4 h-4 text-destructive" />
									{/if}
								{:else}
									<Globe class="w-4 h-4 text-muted-foreground" />
								{/if}
							</div>
							<div class="flex-1 min-w-0">
								<div class="flex items-center gap-2">
									<span class="text-sm font-medium">{source.name}</span>
									{#if validation?.ok && validation.count !== undefined}
										<span class="text-xs text-muted-foreground">({m.templates_sources_template_count({ count: validation.count })})</span>
									{/if}
								</div>
								<div class="text-xs text-muted-foreground truncate">{source.url}</div>
								{#if validation && !validation.ok}
									<div class="text-xs text-destructive mt-0.5">{validation.error}</div>
								{/if}
							</div>
							<TogglePill
								checked={source.enabled}
								onchange={() => toggleSource(source)}
							/>
							{#if !source.builtin}
								<Button
									size="icon-sm"
									variant="ghost"
									onclick={() => removeSource(source)}
								>
									<Trash2 class="w-3.5 h-3.5 text-destructive" />
								</Button>
							{/if}
						</div>
					</Card.Content>
				</Card.Root>
			{/each}
		</div>
	{/if}
</div>
