<script lang="ts">
	import { Label } from '$lib/components/ui/label';
	import * as Select from '$lib/components/ui/select';
	import { TogglePill } from '$lib/components/ui/toggle-pill';
	import CronEditor from '$lib/components/cron-editor.svelte';
	import { Button } from '$lib/components/ui/button';
	import { FileText, RefreshCw, Mail, FileDown, Download } from 'lucide-svelte';
	import { toast } from 'svelte-sonner';
	import { m } from '$lib/paraglide/messages.js';

	interface SmtpChannel {
		id: number;
		name: string;
	}

	interface Props {
		/** The environment this tab belongs to, so the report can be downloaded here. */
		environmentId: number | null;
		reportLoading: boolean;
		reportEnabled: boolean;
		reportCron: string;
		reportFormat: 'pdf' | 'csv';
		reportNotificationId: number | null;
		/** Only SMTP channels: nothing else can carry the attachment. */
		smtpChannels: SmtpChannel[];
		/** A paid licence of either tier; without one the report cannot be built at all. */
		licensed: boolean;
	}

	let {
		environmentId,
		reportLoading,
		reportEnabled = $bindable(),
		reportCron = $bindable(),
		reportFormat = $bindable(),
		reportNotificationId = $bindable(),
		smtpChannels,
		licensed
	}: Props = $props();

	let downloading = $state(false);

	/** Download the report for this environment now, in the format the schedule would send. */
	async function downloadNow(format: 'pdf' | 'csv') {
		if (environmentId === null) return;
		downloading = true;
		try {
			const response = await fetch(`/api/environments/report?format=${format}&env=${environmentId}`);
			if (!response.ok) {
				const message = await response.json().then((b) => b?.error).catch(() => null);
				toast.error(message || m.settings_envs_report_build_failed());
				return;
			}
			const blob = await response.blob();
			const name =
				response.headers.get('Content-Disposition')?.match(/filename="([^"]+)"/)?.[1] ??
				`dockhand-report.${format}`;
			const url = URL.createObjectURL(blob);
			const link = document.createElement('a');
			link.href = url;
			link.download = name;
			link.click();
			URL.revokeObjectURL(url);
		} catch (error) {
			console.error('Failed to download the report:', error);
			toast.error(m.settings_envs_report_build_failed());
		} finally {
			downloading = false;
		}
	}

	const formatLabel = $derived(reportFormat === 'csv' ? 'CSV' : 'PDF');
	const channelLabel = $derived(
		smtpChannels.find((c) => c.id === reportNotificationId)?.name ?? m.settings_envs_report_select_channel()
	);
</script>

<div class="space-y-4">
	<div class="flex items-center gap-2 text-sm font-medium">
		<FileText class="w-4 h-4" />
		{m.settings_envs_report_title()}
	</div>
	<p class="text-xs text-muted-foreground">
		{m.settings_envs_report_description()}
	</p>

	{#if !licensed}
		<div class="rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
			{m.settings_envs_report_license_required()}
		</div>
	{:else if reportLoading}
		<div class="flex items-center justify-center py-4">
			<RefreshCw class="w-5 h-5 animate-spin text-muted-foreground" />
		</div>
	{:else}
		<!-- Downloading is the common case; the schedule below is the standing arrangement. -->
		<div class="flex items-center gap-2 rounded-md border border-border bg-muted/30 p-3">
			<Download class="w-4 h-4 text-muted-foreground shrink-0" />
			<div class="flex-1 min-w-0">
				<Label>{m.settings_envs_report_download()}</Label>
				<p class="text-xs text-muted-foreground">{m.settings_envs_report_download_hint()}</p>
			</div>
			<Button size="sm" variant="outline" disabled={downloading || environmentId === null}
				onclick={() => downloadNow('pdf')}>PDF</Button>
			<Button size="sm" variant="outline" disabled={downloading || environmentId === null}
				onclick={() => downloadNow('csv')}>CSV</Button>
		</div>

		<div class="flex items-start gap-2 pt-1">
			<FileDown class="w-4 h-4 text-sky-500 mt-0.5 shrink-0" />
			<div class="flex-1">
				<Label>{m.settings_envs_report_schedule_enable()}</Label>
				<p class="text-xs text-muted-foreground">
					{m.settings_envs_report_schedule_enable_hint()}
				</p>
			</div>
			<TogglePill bind:checked={reportEnabled} />
		</div>

		{#if reportEnabled}
			<div class="flex items-start gap-2">
				<div class="w-4 shrink-0"></div>
				<div class="flex-1 space-y-2">
					<Label>{m.settings_envs_schedule()}</Label>
					<CronEditor value={reportCron} onchange={(cron) => (reportCron = cron)} />
				</div>
			</div>

			<div class="flex items-start gap-2">
				<div class="w-4 shrink-0"></div>
				<div class="flex-1 space-y-2">
					<Label>{m.settings_envs_report_format()}</Label>
					<Select.Root type="single" bind:value={reportFormat}>
						<Select.Trigger class="w-full">{formatLabel}</Select.Trigger>
						<Select.Content>
							<Select.Item value="pdf">{m.settings_envs_report_format_pdf()}</Select.Item>
							<Select.Item value="csv">{m.settings_envs_report_format_csv()}</Select.Item>
						</Select.Content>
					</Select.Root>
				</div>
			</div>

			<div class="flex items-start gap-2">
				<Mail class="w-4 h-4 text-muted-foreground mt-7 shrink-0" />
				<div class="flex-1 space-y-2">
					<Label>{m.settings_envs_report_send_to()}</Label>
					{#if smtpChannels.length === 0}
						<p class="text-xs text-amber-600 dark:text-amber-400">
							{m.settings_envs_report_no_smtp_channel()}
						</p>
					{:else}
						<Select.Root
							type="single"
							value={reportNotificationId === null ? '' : String(reportNotificationId)}
							onValueChange={(v) => (reportNotificationId = v ? parseInt(v, 10) : null)}
						>
							<Select.Trigger class="w-full">{channelLabel}</Select.Trigger>
							<Select.Content>
								{#each smtpChannels as channel (channel.id)}
									<Select.Item value={String(channel.id)}>{channel.name}</Select.Item>
								{/each}
							</Select.Content>
						</Select.Root>
						<p class="text-xs text-muted-foreground">
							{m.settings_envs_report_smtp_only_hint()}
						</p>
					{/if}
				</div>
			</div>
		{/if}
	{/if}
</div>
