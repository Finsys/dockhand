<script lang="ts">
	import { Label } from '$lib/components/ui/label';
	import * as Select from '$lib/components/ui/select';
	import { TogglePill } from '$lib/components/ui/toggle-pill';
	import CronEditor from '$lib/components/cron-editor.svelte';
	import { Button } from '$lib/components/ui/button';
	import { FileText, RefreshCw, Mail, FileDown, Download } from 'lucide-svelte';
	import { toast } from 'svelte-sonner';

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
				toast.error(message || 'Failed to build the report');
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
			toast.error('Failed to build the report');
		} finally {
			downloading = false;
		}
	}

	const formatLabel = $derived(reportFormat === 'csv' ? 'CSV' : 'PDF');
	const channelLabel = $derived(
		smtpChannels.find((c) => c.id === reportNotificationId)?.name ?? 'Select a channel'
	);
</script>

<div class="space-y-4">
	<div class="flex items-center gap-2 text-sm font-medium">
		<FileText class="w-4 h-4" />
		Scheduled state report
	</div>
	<p class="text-xs text-muted-foreground">
		Mail a report of what is running in this environment, with its vulnerability counts and scan
		coverage, on a schedule.
	</p>

	{#if !licensed}
		<div class="rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
			A commercial license is required to build a state report.
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
				<Label>Download this environment's report</Label>
				<p class="text-xs text-muted-foreground">Build it now, for this environment only.</p>
			</div>
			<Button size="sm" variant="outline" disabled={downloading || environmentId === null}
				onclick={() => downloadNow('pdf')}>PDF</Button>
			<Button size="sm" variant="outline" disabled={downloading || environmentId === null}
				onclick={() => downloadNow('csv')}>CSV</Button>
		</div>

		<div class="flex items-start gap-2 pt-1">
			<FileDown class="w-4 h-4 text-sky-500 mt-0.5 shrink-0" />
			<div class="flex-1">
				<Label>Send a report on a schedule</Label>
				<p class="text-xs text-muted-foreground">
					The report lists every container and the vulnerabilities known about its images, and it
					leaves this installation as a mail attachment.
				</p>
			</div>
			<TogglePill bind:checked={reportEnabled} />
		</div>

		{#if reportEnabled}
			<div class="flex items-start gap-2">
				<div class="w-4 shrink-0"></div>
				<div class="flex-1 space-y-2">
					<Label>Schedule</Label>
					<CronEditor value={reportCron} onchange={(cron) => (reportCron = cron)} />
				</div>
			</div>

			<div class="flex items-start gap-2">
				<div class="w-4 shrink-0"></div>
				<div class="flex-1 space-y-2">
					<Label>Format</Label>
					<Select.Root type="single" bind:value={reportFormat}>
						<Select.Trigger class="w-full">{formatLabel}</Select.Trigger>
						<Select.Content>
							<Select.Item value="pdf">PDF - formatted for reading and filing</Select.Item>
							<Select.Item value="csv">CSV - for a spreadsheet or another tool</Select.Item>
						</Select.Content>
					</Select.Root>
				</div>
			</div>

			<div class="flex items-start gap-2">
				<Mail class="w-4 h-4 text-muted-foreground mt-7 shrink-0" />
				<div class="flex-1 space-y-2">
					<Label>Send to</Label>
					{#if smtpChannels.length === 0}
						<p class="text-xs text-amber-600 dark:text-amber-400">
							No SMTP channel is configured. Add one under Settings &gt; Notifications - a webhook
							channel cannot carry the attachment. Until then, turn the schedule off above:
							it cannot be saved without a channel.
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
							Only SMTP channels are listed; the report is sent as an attachment.
						</p>
					{/if}
				</div>
			</div>
		{/if}
	{/if}
</div>
