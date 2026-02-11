<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { Plus, Trash2, Key, AlertCircle, CheckCircle2, FileText, Pencil, CircleDot, Undo2 } from 'lucide-svelte';

	export interface EnvVar {
		key: string;
		value: string;
		isSecret: boolean;
	}

	export interface ValidationResult {
		valid: boolean;
		required: string[];
		optional: string[];
		defined: string[];
		missing: string[];
		unused: string[];
	}

	interface Props {
		variables: EnvVar[];
		validation?: ValidationResult | null;
		readonly?: boolean;
		showSource?: boolean; // For git stacks - show where variable comes from
		sources?: Record<string, 'file' | 'override'>; // Key -> source mapping
		fileValues?: Record<string, string>; // Original file values for revert
		placeholder?: { key: string; value: string };
		existingSecretKeys?: Set<string>; // Keys of secrets loaded from DB (can't toggle visibility)
		onchange?: () => void;
	}

	let {
		variables = $bindable(),
		validation = null,
		readonly = false,
		showSource = false,
		sources = {},
		fileValues = {},
		placeholder = { key: 'VARIABLE_NAME', value: 'value' },
		existingSecretKeys = new Set<string>(),
		onchange
	}: Props = $props();

	// Check if a variable is an existing secret that was loaded from DB
	function isExistingSecret(key: string, isSecret: boolean): boolean {
		return isSecret && existingSecretKeys.has(key);
	}

	function addVariable() {
		variables = [...variables, { key: '', value: '', isSecret: false }];
		onchange?.();
	}

	function removeVariable(index: number) {
		variables = variables.filter((_, i) => i !== index);
		onchange?.();
	}

	function toggleSecret(index: number) {
		variables[index].isSecret = !variables[index].isSecret;
		onchange?.();
	}

	// Check if a variable key is missing (required but not defined)
	function isMissing(key: string): boolean {
		return validation?.missing?.includes(key) ?? false;
	}

	// Check if a variable key is unused (defined but not in compose)
	function isUnused(key: string): boolean {
		return validation?.unused?.includes(key) ?? false;
	}

	// Check if a variable key is required
	function isRequired(key: string): boolean {
		return validation?.required?.includes(key) ?? false;
	}

	// Check if a variable key is optional
	function isOptional(key: string): boolean {
		return validation?.optional?.includes(key) ?? false;
	}

	// Get validation status class for key input
	function getKeyValidationClass(key: string): string {
		if (!key || !validation) return '';
		if (isMissing(key)) return 'border-red-500 dark:border-red-400';
		if (isUnused(key)) return 'border-amber-500 dark:border-amber-400';
		if (isRequired(key) || isOptional(key)) return 'border-green-500 dark:border-green-400';
		return '';
	}

	// Get source icon for a variable
	function getSource(key: string): 'file' | 'override' | null {
		if (!showSource || !sources) return null;
		return sources[key] || null;
	}

	// Count non-empty variables
	const variableCount = $derived(variables.filter(v => v.key).length);
	const secretCount = $derived(variables.filter(v => v.key && v.isSecret).length);
</script>

<div class="space-y-3">
	<!-- Variables List -->
	<div class="space-y-3">
		{#each variables as variable, index (index)}
			{@const source = getSource(variable.key)}
			{@const isVarRequired = isRequired(variable.key)}
			{@const isVarOptional = isOptional(variable.key)}
			{@const isVarMissing = isMissing(variable.key)}
			{@const isVarUnused = isUnused(variable.key)}
			<div class="flex gap-2 items-center">
				<!-- Source indicator (for git stacks) - always reserve space if showSource -->
				{#if showSource}
					<div class="flex items-center h-9 w-5 justify-center shrink-0">
						{#if source === 'file'}
							<Tooltip.Root>
								<Tooltip.Trigger>
									<FileText class="w-3.5 h-3.5 text-muted-foreground" />
								</Tooltip.Trigger>
								<Tooltip.Content side="bottom"><p class="whitespace-nowrap">From env file in repository</p></Tooltip.Content>
							</Tooltip.Root>
						{:else if source === 'override'}
							<Tooltip.Root>
								<Tooltip.Trigger>
									{#if fileValues[variable.key] !== undefined}
										<button
											type="button"
											class="cursor-pointer hover:text-orange-400 transition-colors"
											onclick={() => {
												variables = variables.map(v =>
													v.key === variable.key ? { ...v, value: fileValues[variable.key] } : v
												);
												onchange?.();
											}}
										>
											<Undo2 class="w-3.5 h-3.5 text-blue-500 hover:text-orange-400" />
										</button>
									{:else}
										<Pencil class="w-3.5 h-3.5 text-blue-500" />
									{/if}
								</Tooltip.Trigger>
								<Tooltip.Content side="bottom"><p class="whitespace-nowrap">{fileValues[variable.key] !== undefined ? 'Revert to file value' : 'Manual override (not in file)'}</p></Tooltip.Content>
							</Tooltip.Root>
						{/if}
					</div>
				{/if}

				<!-- Validation status indicator - always reserve space if validation exists -->
				{#if validation}
					<div class="flex items-center h-9 w-5 justify-center shrink-0">
						{#if variable.key}
							{#if isVarRequired && !isVarMissing}
								<Tooltip.Root>
									<Tooltip.Trigger>
										<CheckCircle2 class="w-4 h-4 text-green-500" />
									</Tooltip.Trigger>
									<Tooltip.Content><p>Required variable defined</p></Tooltip.Content>
								</Tooltip.Root>
							{:else if isVarOptional}
								<Tooltip.Root>
									<Tooltip.Trigger>
										<CircleDot class="w-4 h-4 text-blue-400" />
									</Tooltip.Trigger>
									<Tooltip.Content><p>Optional variable (has default)</p></Tooltip.Content>
								</Tooltip.Root>
							{:else if isVarUnused}
								<Tooltip.Root>
									<Tooltip.Trigger>
										<AlertCircle class="w-4 h-4 text-amber-500" />
									</Tooltip.Trigger>
									<Tooltip.Content><p>Unused variable</p></Tooltip.Content>
								</Tooltip.Root>
							{/if}
						{/if}
					</div>
				{/if}

				<!-- Key Input with floating label -->
				<div class="flex-1 relative">
					<span class="absolute -top-2 left-2 text-2xs text-muted-foreground bg-background px-1">Name</span>
					<Input
						bind:value={variable.key}
						disabled={readonly}
						oninput={() => onchange?.()}
						class="h-9 font-mono text-xs"
					/>
				</div>

				<!-- Value Input with floating label -->
				<div class="flex-1 relative">
					<span class="absolute -top-2 left-2 text-2xs text-muted-foreground bg-background px-1">Value</span>
					<Input
						bind:value={variable.value}
						type={variable.isSecret ? 'password' : 'text'}
						disabled={readonly}
						oninput={() => onchange?.()}
						class="h-9 font-mono text-xs"
					/>
				</div>

				<!-- Secret Toggle Button -->
				{#if !readonly}
					{@const existingSecret = isExistingSecret(variable.key, variable.isSecret)}
					{#if existingSecret}
						<!-- Existing secret from DB - show locked icon, no toggle (value can still be modified) -->
						<div class="flex items-center h-9 w-9 justify-center shrink-0" title="Secret value (cannot unhide)">
							<Key class="w-3.5 h-3.5 text-amber-500" />
						</div>
					{:else}
						<!-- New or non-secret variable - show toggle button -->
						<button
							type="button"
							onclick={() => toggleSecret(index)}
							title={variable.isSecret ? 'Marked as secret' : 'Mark as secret'}
							class="h-9 w-9 flex items-center justify-center rounded-md shrink-0 transition-colors {variable.isSecret ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300' : 'text-muted-foreground hover:text-foreground hover:bg-muted'}"
						>
							<Key class="w-3.5 h-3.5" />
						</button>
					{/if}
				{:else if variable.isSecret}
					<div class="flex items-center h-9 w-9 justify-center shrink-0">
						<Key class="w-3.5 h-3.5 text-amber-500" />
					</div>
				{/if}

				<!-- Remove Button -->
				{#if !readonly}
					<Button
						type="button"
						variant="ghost"
						size="icon"
						onclick={() => removeVariable(index)}
						class="h-9 w-9 shrink-0 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
					>
						<Trash2 class="w-3.5 h-3.5" />
					</Button>
				{/if}
			</div>
		{/each}

		<!-- Empty state -->
		{#if variables.length === 0}
			<div class="text-center py-6 text-muted-foreground">
				<p class="text-sm">No environment variables defined.</p>
				{#if !readonly}
					<Button type="button" variant="link" onclick={addVariable} class="mt-1 text-xs">
						<Plus class="w-3 h-3" />
						Add your first variable
					</Button>
				{/if}
			</div>
		{/if}
	</div>
</div>
