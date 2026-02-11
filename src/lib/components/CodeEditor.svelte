<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { EditorState, StateField, StateEffect, RangeSet } from '@codemirror/state';
	import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, gutter, GutterMarker, Decoration, WidgetType, type DecorationSet } from '@codemirror/view';
	// Note: Secret masking was removed - secrets are now excluded from the raw editor entirely
	// and are only stored in the database (never written to .env file)
	import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
	import { syntaxHighlighting, defaultHighlightStyle, indentOnInput, bracketMatching, StreamLanguage, type StreamParser } from '@codemirror/language';
	import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
	import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
	import { oneDarkHighlightStyle } from '@codemirror/theme-one-dark';

	// Simple dotenv/env file language parser
	const dotenvParser: StreamParser<{ inValue: boolean }> = {
		startState() {
			return { inValue: false };
		},
		token(stream, state) {
			// Start of line
			if (stream.sol()) {
				state.inValue = false;
				// Skip leading whitespace
				stream.eatSpace();
				// Comment line
				if (stream.peek() === '#') {
					stream.skipToEnd();
					return 'comment';
				}
			}
			// If in value part, consume the rest
			if (state.inValue) {
				stream.skipToEnd();
				return 'string';
			}
			// Variable name before =
			if (stream.match(/^[a-zA-Z_][a-zA-Z0-9_]*/)) {
				if (stream.peek() === '=') {
					return 'variableName.definition';
				}
				return 'variableName';
			}
			// Equals sign - switch to value mode
			if (stream.eat('=')) {
				state.inValue = true;
				return 'operator';
			}
			// Skip anything else
			stream.next();
			return null;
		}
	};

	// Docker Compose keywords for autocomplete
	const COMPOSE_TOP_LEVEL = ['services', 'networks', 'volumes', 'configs', 'secrets', 'name', 'version'];

	const COMPOSE_SERVICE_KEYS = [
		'annotations', 'attach', 'build', 'blkio_config', 'cap_add', 'cap_drop', 'cgroup', 'cgroup_parent',
		'command', 'configs', 'container_name', 'cpu_count', 'cpu_percent', 'cpu_period', 'cpu_quota',
		'cpu_rt_period', 'cpu_rt_runtime', 'cpu_shares', 'cpus', 'cpuset', 'credential_spec',
		'depends_on', 'deploy', 'develop', 'device_cgroup_rules', 'devices', 'dns', 'dns_opt', 'dns_search',
		'domainname', 'driver_opts', 'entrypoint', 'env_file', 'environment', 'expose', 'extends',
		'external_links', 'extra_hosts', 'gpus', 'group_add', 'healthcheck', 'hostname', 'image', 'init',
		'ipc', 'isolation', 'labels', 'label_file', 'links', 'logging', 'mac_address', 'mem_limit',
		'mem_reservation', 'mem_swappiness', 'memswap_limit', 'models', 'network_mode', 'networks',
		'oom_kill_disable', 'oom_score_adj', 'pid', 'pids_limit', 'platform', 'ports', 'post_start',
		'pre_stop', 'privileged', 'profiles', 'provider', 'pull_policy', 'read_only', 'restart', 'runtime',
		'scale', 'secrets', 'security_opt', 'shm_size', 'stdin_open', 'stop_grace_period', 'stop_signal',
		'storage_opt', 'sysctls', 'tmpfs', 'tty', 'ulimits', 'use_api_socket', 'user', 'userns_mode', 'uts',
		'volumes', 'volumes_from', 'working_dir'
	];

	const COMPOSE_BUILD_KEYS = [
		'context', 'dockerfile', 'dockerfile_inline', 'args', 'ssh', 'cache_from', 'cache_to',
		'extra_hosts', 'isolation', 'labels', 'no_cache', 'pull', 'shm_size', 'target', 'secrets',
		'tags', 'platforms', 'privileged', 'network'
	];

	const COMPOSE_DEPLOY_KEYS = [
		'mode', 'replicas', 'endpoint_mode', 'labels', 'placement', 'resources', 'restart_policy',
		'rollback_config', 'update_config'
	];

	const COMPOSE_HEALTHCHECK_KEYS = [
		'test', 'interval', 'timeout', 'retries', 'start_period', 'start_interval', 'disable'
	];

	const COMPOSE_LOGGING_KEYS = ['driver', 'options'];

	const COMPOSE_NETWORK_TOP_LEVEL = [
		'driver', 'driver_opts', 'attachable', 'enable_ipv6', 'external', 'internal', 'ipam', 'labels', 'name'
	];

	const COMPOSE_VOLUME_TOP_LEVEL = [
		'driver', 'driver_opts', 'external', 'labels', 'name'
	];

	const COMPOSE_DEPENDS_ON_VALUES = ['service_started', 'service_healthy', 'service_completed_successfully'];

	const COMPOSE_RESTART_VALUES = ['no', 'always', 'on-failure', 'unless-stopped'];

	const COMPOSE_PULL_POLICY_VALUES = ['always', 'never', 'missing', 'build', 'daily', 'weekly'];

	const COMPOSE_NETWORK_MODE_VALUES = ['none', 'host', 'bridge'];

	// All Docker Compose keywords combined for autocomplete
	const ALL_COMPOSE_KEYWORDS = [
		...COMPOSE_TOP_LEVEL,
		...COMPOSE_SERVICE_KEYS,
		...COMPOSE_BUILD_KEYS,
		...COMPOSE_DEPLOY_KEYS,
		...COMPOSE_HEALTHCHECK_KEYS,
		...COMPOSE_LOGGING_KEYS,
		...COMPOSE_NETWORK_TOP_LEVEL,
		...COMPOSE_VOLUME_TOP_LEVEL
	].filter((v, i, a) => a.indexOf(v) === i).sort(); // Remove duplicates and sort

	// Docker Compose autocomplete source - always suggest all keywords
	function composeCompletions(context: CompletionContext): CompletionResult | null {
		// Get word before cursor
		const word = context.matchBefore(/[a-z_]*/);
		if (!word) return null;

		// Only show completions if typing (not empty) or explicitly requested
		if (word.from === word.to && !context.explicit) return null;

		const line = context.state.doc.lineAt(context.pos);
		const textBefore = line.text.slice(0, context.pos - line.from);

		// Don't show in value position (after colon with content)
		if (textBefore.match(/:\s*\S/)) return null;

		return {
			from: word.from,
			options: ALL_COMPOSE_KEYWORDS.map(label => ({
				label,
				type: 'keyword',
				apply: label + ':'
			})),
			validFor: /^[a-z_]*$/
		};
	}

	// Value completions for specific keys
	function composeValueCompletions(context: CompletionContext): CompletionResult | null {
		const line = context.state.doc.lineAt(context.pos);
		const textBefore = line.text.slice(0, context.pos - line.from);

		// Check if we're after a key: pattern (value position)
		const valueMatch = textBefore.match(/^\s*([a-z_]+):\s*/);
		if (!valueMatch) return null;

		const key = valueMatch[1];

		// Get word at cursor for value
		const word = context.matchBefore(/[a-z_-]*/);
		if (!word) return null;
		if (word.from === word.to && !context.explicit) return null;

		let options: string[] = [];

		switch (key) {
			case 'restart':
				options = COMPOSE_RESTART_VALUES;
				break;
			case 'pull_policy':
				options = COMPOSE_PULL_POLICY_VALUES;
				break;
			case 'network_mode':
				options = COMPOSE_NETWORK_MODE_VALUES;
				break;
			case 'condition':
				options = COMPOSE_DEPENDS_ON_VALUES;
				break;
			default:
				return null;
		}

		return {
			from: word.from,
			options: options.map(label => ({
				label,
				type: 'value'
			})),
			validFor: /^[a-z_-]*$/
		};
	}

	// Language imports
	import { yaml } from '@codemirror/lang-yaml';
	import { json } from '@codemirror/lang-json';
	import { javascript } from '@codemirror/lang-javascript';
	import { python } from '@codemirror/lang-python';
	import { html } from '@codemirror/lang-html';
	import { css } from '@codemirror/lang-css';
	import { markdown } from '@codemirror/lang-markdown';
	import { xml } from '@codemirror/lang-xml';
	import { sql } from '@codemirror/lang-sql';

	export interface VariableMarker {
		name: string;
		type: 'required' | 'optional' | 'missing';
		value?: string; // The value provided in env vars editor
		isSecret?: boolean; // Whether to mask the value
		defaultValue?: string; // The default value from compose syntax (e.g., ${VAR:-default})
	}

	interface Props {
		value: string;
		language?: string;
		readonly?: boolean;
		theme?: 'dark' | 'light';
		onchange?: (value: string) => void;
		class?: string;
		variableMarkers?: VariableMarker[];
	}

	let { value = '', language = 'yaml', readonly = false, theme = 'dark', onchange, class: className = '', variableMarkers: variableMarkersProp = [] }: Props = $props();

	// Keep markers reactive - destructured props with defaults lose reactivity
	const variableMarkers = $derived(variableMarkersProp);

	let container: HTMLDivElement;
	let view: EditorView | null = null;

	// Mutable ref for callback - allows updating without recreating editor
	let onchangeRef: ((value: string) => void) | undefined = onchange;

	// Flag to suppress onchange during programmatic value sync
	let isSyncingExternalValue = false;

	// Keep callback ref updated when prop changes
	$effect(() => {
		onchangeRef = onchange;
	});

	// Variable marker gutter icons
	class VariableGutterMarker extends GutterMarker {
		type: 'required' | 'optional' | 'missing';
		hasValue: boolean;

		constructor(type: 'required' | 'optional' | 'missing', hasValue: boolean = false) {
			super();
			this.type = type;
			this.hasValue = hasValue;
		}

		toDOM() {
			const wrapper = document.createElement('span');
			wrapper.className = 'var-marker-wrapper';

			// The colored dot
			const dot = document.createElement('span');
			dot.className = `var-marker var-marker-${this.type}`;
			dot.title = this.type === 'missing' ? 'Missing required variable'
				: this.type === 'required' ? 'Required variable (defined)'
				: 'Optional variable (has default)';
			wrapper.appendChild(dot);

			// Checkmark if value is provided
			if (this.hasValue) {
				const check = document.createElement('span');
				check.className = 'var-marker-check';
				check.innerHTML = '✓';
				check.title = 'Value provided';
				wrapper.appendChild(check);
			}

			return wrapper;
		}
	}

	// Widget to show variable value as inline overlay
	// Supports three states: provided (green), default (blue), missing (red)
	class VariableValueWidget extends WidgetType {
		value: string;
		isSecret: boolean;
		variant: 'provided' | 'default' | 'missing';

		constructor(value: string, isSecret: boolean = false, variant: 'provided' | 'default' | 'missing' = 'provided') {
			super();
			this.value = value;
			this.isSecret = isSecret;
			this.variant = variant;
		}

		toDOM() {
			const span = document.createElement('span');
			span.className = `var-value-overlay var-value-${this.variant}`;

			if (this.variant === 'missing') {
				// Red MISSING badge with icon
				span.innerHTML = '⚠ MISSING';
				span.title = 'Required variable not defined';
			} else {
				span.textContent = this.isSecret ? '••••••' : this.value;
				span.title = this.isSecret ? 'Secret value' : this.value;
			}
			return span;
		}

		eq(other: VariableValueWidget) {
			return this.value === other.value && this.isSecret === other.isSecret && this.variant === other.variant;
		}
	}

	// Create inline value decorations
	function createValueDecorations(doc: any, markers: VariableMarker[]): DecorationSet {
		const decorations: {from: number, to: number, decoration: Decoration}[] = [];

		if (markers.length === 0) return Decoration.none;

		const text = doc.toString();

		for (const marker of markers) {
			// Find all occurrences of this variable in the text
			// Match ${VAR_NAME} or ${VAR_NAME:-...} or $VAR_NAME patterns
			// Use negative lookbehind (?<!\$) to skip escaped $$ (Docker Compose escape syntax)
			const patterns = [
				{ regex: new RegExp(`(?<!\\$)\\$\\{${marker.name}\\}`, 'g'), hasDefault: false },
				{ regex: new RegExp(`(?<!\\$)\\$\\{${marker.name}:-([^}]*)\\}`, 'g'), hasDefault: true },
				{ regex: new RegExp(`(?<!\\$)\\$\\{${marker.name}-([^}]*)\\}`, 'g'), hasDefault: true },
				{ regex: new RegExp(`(?<!\\$)\\$\\{${marker.name}:\\?[^}]*\\}`, 'g'), hasDefault: false },
				{ regex: new RegExp(`(?<!\\$)\\$\\{${marker.name}\\?[^}]*\\}`, 'g'), hasDefault: false },
				{ regex: new RegExp(`(?<!\\$)\\$\\{${marker.name}:\\+[^}]*\\}`, 'g'), hasDefault: false },
				{ regex: new RegExp(`(?<!\\$)\\$\\{${marker.name}\\+[^}]*\\}`, 'g'), hasDefault: false },
			];

			for (const { regex, hasDefault } of patterns) {
				let match;
				while ((match = regex.exec(text)) !== null) {
					const from = match.index;
					const to = from + match[0].length;

					// Determine what to show:
					// 1. If value is provided in env vars editor -> green with that value
					// 2. If no value but has default in syntax -> blue with default value
					// 3. If no value and no default (missing) -> red MISSING

					let widget: VariableValueWidget;

					if (marker.value) {
						// Value provided in env vars editor -> GREEN
						widget = new VariableValueWidget(marker.value, marker.isSecret ?? false, 'provided');
					} else if (hasDefault && match[1]) {
						// Has default value from compose syntax -> BLUE
						widget = new VariableValueWidget(match[1], false, 'default');
					} else if (marker.defaultValue) {
						// Has default value from marker -> BLUE
						widget = new VariableValueWidget(marker.defaultValue, false, 'default');
					} else if (marker.type === 'missing') {
						// Missing required variable -> RED
						widget = new VariableValueWidget('', false, 'missing');
					} else {
						// Skip if nothing to show
						continue;
					}

					// Add widget decoration at the end of the variable
					decorations.push({
						from: to,
						to: to,
						decoration: Decoration.widget({
							widget,
							side: 1
						})
					});
				}
			}
		}

		// Sort by position
		decorations.sort((a, b) => a.from - b.from);
		return Decoration.set(decorations.map(d => d.decoration.range(d.from, d.to)));
	}

	// Create decorations for variable markers
	function createVariableDecorations(doc: any, markers: VariableMarker[]): RangeSet<GutterMarker> {
		const gutterMarkers: {from: number, marker: GutterMarker}[] = [];

		if (markers.length === 0) return RangeSet.empty;

		const text = doc.toString();
		const lines = text.split('\n');
		let pos = 0;

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];

			// Skip commented lines (YAML comments start with #)
			const trimmedLine = line.trim();
			if (trimmedLine.startsWith('#')) {
				pos += line.length + 1;
				continue;
			}

			// Check if this line contains any of our marked variables
			for (const marker of markers) {
				// Match ${VAR_NAME} or ${VAR_NAME:-...} patterns
				// Use regex with negative lookbehind to skip escaped $$ (Docker Compose escape syntax)
				const varPatterns = [
					new RegExp(`(?<!\\$)\\$\\{${marker.name}\\}`),
					new RegExp(`(?<!\\$)\\$\\{${marker.name}:-`),
					new RegExp(`(?<!\\$)\\$\\{${marker.name}-`),
					new RegExp(`(?<!\\$)\\$\\{${marker.name}:\\?`),
					new RegExp(`(?<!\\$)\\$\\{${marker.name}\\?`),
					new RegExp(`(?<!\\$)\\$\\{${marker.name}:\\+`),
					new RegExp(`(?<!\\$)\\$\\{${marker.name}\\+`),
					new RegExp(`(?<!\\$)\\$${marker.name}(?![a-zA-Z0-9_])`)
				];

				const hasVariable = varPatterns.some(p => p.test(line));
				if (hasVariable) {
					gutterMarkers.push({
						from: pos,
						marker: new VariableGutterMarker(marker.type, !!marker.value)
					});
					break; // Only one marker per line
				}
			}

			pos += line.length + 1; // +1 for newline
		}

		// Sort by position and create RangeSet
		gutterMarkers.sort((a, b) => a.from - b.from);
		return RangeSet.of(gutterMarkers.map(m => m.marker.range(m.from)));
	}

	// Effect to update variable markers
	const updateMarkersEffect = StateEffect.define<VariableMarker[]>();

	// State field to store current markers (used for recalculation on doc change)
	const currentMarkersField = StateField.define<VariableMarker[]>({
		create() {
			return [];
		},
		update(markers, tr) {
			for (const effect of tr.effects) {
				if (effect.is(updateMarkersEffect)) {
					return effect.value;
				}
			}
			return markers;
		}
	});

	// State field to track variable markers (gutter)
	// Recalculates on doc change to avoid position mapping issues
	const variableMarkersField = StateField.define<RangeSet<GutterMarker>>({
		create() {
			return RangeSet.empty;
		},
		update(markers, tr) {
			// Check for marker updates first
			for (const effect of tr.effects) {
				if (effect.is(updateMarkersEffect)) {
					return createVariableDecorations(tr.state.doc, effect.value);
				}
			}
			// Recalculate on doc change using stored markers
			if (tr.docChanged) {
				const currentMarkers = tr.state.field(currentMarkersField);
				return createVariableDecorations(tr.state.doc, currentMarkers);
			}
			return markers;
		}
	});

	// State field to track value decorations (inline widgets)
	// Recalculates on doc change to avoid widget duplication issues
	const valueDecorationsField = StateField.define<DecorationSet>({
		create() {
			return Decoration.none;
		},
		update(decorations, tr) {
			// Check for marker updates first
			for (const effect of tr.effects) {
				if (effect.is(updateMarkersEffect)) {
					return createValueDecorations(tr.state.doc, effect.value);
				}
			}
			// Recalculate on doc change using stored markers
			if (tr.docChanged) {
				const currentMarkers = tr.state.field(currentMarkersField);
				return createValueDecorations(tr.state.doc, currentMarkers);
			}
			return decorations;
		},
		provide: f => EditorView.decorations.from(f)
	});

	// Variable markers gutter
	const variableGutter = gutter({
		class: 'cm-variable-gutter',
		markers: view => view.state.field(variableMarkersField),
		initialSpacer: () => new VariableGutterMarker('required')
	});

	// Get language extension based on language name
	function getLanguageExtension(lang: string) {
		switch (lang) {
			case 'yaml':
				return yaml();
			case 'json':
				return json();
			case 'javascript':
			case 'js':
				return javascript();
			case 'typescript':
			case 'ts':
				return javascript({ typescript: true });
			case 'jsx':
				return javascript({ jsx: true });
			case 'tsx':
				return javascript({ jsx: true, typescript: true });
			case 'python':
			case 'py':
				return python();
			case 'html':
				return html();
			case 'css':
				return css();
			case 'markdown':
			case 'md':
				return markdown();
			case 'xml':
				return xml();
			case 'sql':
				return sql();
			case 'dockerfile':
			case 'shell':
			case 'bash':
			case 'sh':
				// No dedicated shell/dockerfile support, use basic highlighting
				return [];
			case 'dotenv':
			case 'env':
				return StreamLanguage.define(dotenvParser);
			default:
				return [];
		}
	}

	// Create custom dark theme that matches our UI
	const dockhandDark = EditorView.theme({
		'&': {
			backgroundColor: '#1a1a1a',
			color: '#d4d4d4',
			height: '100%',
			fontSize: '13px'
		},
		'.cm-content': {
			fontFamily: 'var(--font-editor, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace)',
			padding: '8px 0'
		},
		'.cm-gutters': {
			backgroundColor: '#1a1a1a',
			color: '#858585',
			border: 'none',
			fontFamily: 'var(--font-editor, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace)',
			fontSize: '13px'
		},
		'.cm-activeLineGutter': {
			backgroundColor: '#2a2a2a'
		},
		'.cm-activeLine': {
			backgroundColor: '#2a2a2a'
		},
		'.cm-selectionBackground': {
			backgroundColor: 'yellow !important'
		},
		'&.cm-focused .cm-selectionBackground': {
			backgroundColor: 'yellow !important'
		},
		'&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
			backgroundColor: 'yellow !important'
		},
		'.cm-cursor': {
			borderLeftColor: '#d4d4d4'
		},
		'.cm-line': {
			padding: '0 8px'
		}
	}, { dark: true });

	// Create custom light theme
	const dockhandLight = EditorView.theme({
		'&': {
			backgroundColor: '#fafafa',
			color: '#3f3f46',
			height: '100%',
			fontSize: '13px'
		},
		'.cm-content': {
			fontFamily: 'var(--font-editor, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace)',
			padding: '8px 0'
		},
		'.cm-gutters': {
			backgroundColor: '#fafafa',
			color: '#a1a1aa',
			border: 'none',
			fontFamily: 'var(--font-editor, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace)',
			fontSize: '13px'
		},
		'.cm-activeLineGutter': {
			backgroundColor: '#f4f4f5'
		},
		'.cm-activeLine': {
			backgroundColor: '#f4f4f5'
		},
		'.cm-selectionBackground': {
			backgroundColor: '#e4e4e7 !important'
		},
		'&.cm-focused .cm-selectionBackground': {
			backgroundColor: '#e4e4e7 !important'
		},
		'.cm-cursor': {
			borderLeftColor: '#3f3f46'
		},
		'.cm-line': {
			padding: '0 8px'
		}
	}, { dark: false });

	// Track if we're initialized (prevents multiple createEditor calls)
	let initialized = false;

	// Debounce timer for marker updates (prevents flicker during fast typing)
	let markerUpdateTimer: ReturnType<typeof setTimeout> | null = null;
	const MARKER_UPDATE_DEBOUNCE_MS = 300;

	// Track last applied markers to avoid redundant updates
	let lastAppliedMarkersJson = '';

	function createEditor() {
		if (!container || view || initialized) return;
		initialized = true;

		const themeExtensions = theme === 'dark'
			? [dockhandDark, syntaxHighlighting(oneDarkHighlightStyle)]
			: [dockhandLight, syntaxHighlighting(defaultHighlightStyle)];

		// Build autocompletion config - add Docker Compose completions for YAML
		// Note: activateOnTyping can interfere with key repeat, so we disable it
		// Users can still trigger autocomplete manually with Ctrl+Space
		const autocompletionConfig = language === 'yaml'
			? autocompletion({
				override: [composeCompletions, composeValueCompletions],
				activateOnTyping: false
			})
			: autocompletion({ activateOnTyping: false });

		const extensions = [
			lineNumbers(),
			highlightActiveLineGutter(),
			highlightActiveLine(),
			history(),
			indentOnInput(),
			bracketMatching(),
			closeBrackets(),
			autocompletionConfig,
			highlightSelectionMatches(),
			syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
			keymap.of([
				...defaultKeymap,
				...historyKeymap,
				...searchKeymap,
				...completionKeymap,
				...closeBracketsKeymap,
				indentWithTab
			]),
			...themeExtensions,
			EditorView.lineWrapping,
			getLanguageExtension(language)
		].flat();

		if (readonly) {
			extensions.push(EditorState.readOnly.of(true));
		}

		// Always add variable markers gutter and value decorations (can be updated dynamically)
		extensions.push(currentMarkersField, variableMarkersField, variableGutter, valueDecorationsField);

		const state = EditorState.create({
			doc: value,
			extensions
		});

		// Custom transaction handler - applies transactions synchronously but defers callback
		// Based on the Svelte Playground pattern: https://svelte.dev/playground/91649ba3e0ce4122b3b34f3a95a00104
		const dispatchTransactions = (trs: readonly import('@codemirror/state').Transaction[]) => {
			if (!view) return;

			// Apply all transactions synchronously (required by CodeMirror)
			view.update(trs);

			// Check if any transaction changed the document
			// Skip onchange during programmatic value sync (only fire for user edits)
			const lastChangingTr = trs.findLast(tr => tr.docChanged);
			if (lastChangingTr && onchangeRef && !isSyncingExternalValue) {
				// Call synchronously to ensure parent state updates before any
				// reactive $effect runs - this prevents race conditions on iPad Safari
				// where paste content was being overwritten by stale external value
				const newContent = lastChangingTr.newDoc.toString();
				onchangeRef(newContent);
			}
		};

		view = new EditorView({
			state,
			parent: container,
			dispatchTransactions
		});

		// Push initial markers if provided
		if (variableMarkers.length > 0) {
			view.dispatch({
				effects: updateMarkersEffect.of(variableMarkers)
			});
		}
	}

	function destroyEditor() {
		if (markerUpdateTimer) {
			clearTimeout(markerUpdateTimer);
			markerUpdateTimer = null;
		}
		if (view) {
			view.destroy();
			view = null;
		}
		initialized = false;
		lastAppliedMarkersJson = '';
	}

	// Get current editor content
	export function getValue(): string {
		return view?.state.doc.toString() ?? value;
	}

	// Set editor content
	export function setValue(newValue: string) {
		if (view) {
			view.dispatch({
				changes: {
					from: 0,
					to: view.state.doc.length,
					insert: newValue
				}
			});
		}
	}

	// Focus the editor
	export function focus() {
		view?.focus();
	}

	// Update variable markers - this is the key method for parent to call
	// Debounced to prevent flicker during fast typing
	export function updateVariableMarkers(markers: VariableMarker[], immediate = false) {
		if (!view) return;

		// Check if markers actually changed (compare by content, not reference)
		const newJson = JSON.stringify(markers);
		if (newJson === lastAppliedMarkersJson) {
			return; // No change, skip update
		}

		// Clear any pending update
		if (markerUpdateTimer) {
			clearTimeout(markerUpdateTimer);
			markerUpdateTimer = null;
		}

		const applyUpdate = () => {
			if (view) {
				lastAppliedMarkersJson = newJson;
				view.dispatch({
					effects: updateMarkersEffect.of(markers)
				});
			}
		};

		if (immediate) {
			applyUpdate();
		} else {
			markerUpdateTimer = setTimeout(applyUpdate, MARKER_UPDATE_DEBOUNCE_MS);
		}
	}

	onMount(() => {
		createEditor();
	});

	onDestroy(() => {
		destroyEditor();
	});

	// Track previous values for comparison
	let prevLanguage = $state(language);
	let prevTheme = $state(theme);

	// Recreate editor if language or theme changes
	$effect(() => {
		const currentLanguage = language;
		const currentTheme = theme;

		// Only recreate if language or theme actually changed
		if (view && (currentLanguage !== prevLanguage || currentTheme !== prevTheme)) {
			prevLanguage = currentLanguage;
			prevTheme = currentTheme;
			const currentContent = view.state.doc.toString();
			destroyEditor();
			value = currentContent; // Preserve content
			createEditor();
		}
	});

	// Update markers when prop changes (backup mechanism, parent should also call updateVariableMarkers)
	// Uses the debounced update to prevent flicker during fast typing
	$effect(() => {
		const markers = variableMarkers;
		if (view && markers) {
			updateVariableMarkers(markers);
		}
	});

	// Sync external value changes to the editor (e.g., when parent clears the content)
	$effect(() => {
		const externalValue = value;
		if (view) {
			const currentContent = view.state.doc.toString();
			// Only update if the external value differs from editor content
			// This prevents feedback loops from editor changes
			if (externalValue !== currentContent) {
				// Suppress onchange during programmatic sync - only user edits should trigger it
				isSyncingExternalValue = true;
				view.dispatch({
					changes: { from: 0, to: currentContent.length, insert: externalValue }
				});
				isSyncingExternalValue = false;
			}
		}
	});
</script>

<div
	bind:this={container}
	class="h-full w-full overflow-hidden {className}"
></div>

<style>
	div :global(.cm-editor) {
		height: 100%;
	}
	div :global(.cm-scroller) {
		overflow: auto;
	}

	/* Variable marker gutter */
	div :global(.cm-variable-gutter) {
		width: 28px;
		min-width: 28px;
	}

	div :global(.var-marker-wrapper) {
		display: inline-flex;
		align-items: center;
		gap: 2px;
		padding-left: 2px;
	}

	div :global(.var-marker-check) {
		color: #22c55e;
		font-size: 14px;
		font-weight: bold;
		line-height: 1;
		margin-top: -1px;
	}

	div :global(.var-marker) {
		display: inline-block;
		width: 8px;
		height: 8px;
		border-radius: 50%;
		margin: 4px 3px;
		cursor: help;
	}

	div :global(.var-marker-required) {
		background-color: #22c55e; /* green-500 */
		box-shadow: 0 0 4px #22c55e;
	}

	div :global(.var-marker-optional) {
		background-color: #60a5fa; /* blue-400 */
		box-shadow: 0 0 4px #60a5fa;
	}

	div :global(.var-marker-missing) {
		background-color: #ef4444; /* red-500 */
		box-shadow: 0 0 4px #ef4444;
	}

	/* Variable value overlay widget - base styles */
	div :global(.var-value-overlay) {
		display: inline-block;
		margin-left: 4px;
		padding: 0 6px;
		font-size: 11px;
		font-family: inherit;
		border-radius: 4px;
		max-width: 150px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		vertical-align: middle;
		cursor: help;
	}

	/* Provided value - GREEN */
	div :global(.var-value-provided) {
		background-color: rgba(34, 197, 94, 0.15);
		color: #22c55e;
		border: 1px solid rgba(34, 197, 94, 0.3);
	}

	/* Default value - BLUE */
	div :global(.var-value-default) {
		background-color: rgba(96, 165, 250, 0.15);
		color: #60a5fa;
		border: 1px solid rgba(96, 165, 250, 0.3);
	}

	/* Missing value - RED */
	div :global(.var-value-missing) {
		background-color: rgba(239, 68, 68, 0.15);
		color: #ef4444;
		border: 1px solid rgba(239, 68, 68, 0.3);
		font-weight: 600;
	}

	/* Light theme adjustments */
	:global(.cm-editor:not(.cm-dark)) div :global(.var-value-provided) {
		background-color: rgba(34, 197, 94, 0.1);
		color: #16a34a;
		border-color: rgba(34, 197, 94, 0.4);
	}

	:global(.cm-editor:not(.cm-dark)) div :global(.var-value-default) {
		background-color: rgba(59, 130, 246, 0.1);
		color: #2563eb;
		border-color: rgba(59, 130, 246, 0.4);
	}

	:global(.cm-editor:not(.cm-dark)) div :global(.var-value-missing) {
		background-color: rgba(239, 68, 68, 0.1);
		color: #dc2626;
		border-color: rgba(239, 68, 68, 0.4);
	}
</style>
