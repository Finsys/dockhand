<script lang="ts">
	import { onMount, onDestroy, untrack } from 'svelte';
	import cytoscape from 'cytoscape';
	import yaml from 'js-yaml';
	import {
		Box, Database, Network, HardDrive, Lock, FileText,
		ZoomIn, ZoomOut, Maximize2, RotateCcw, Plus, Link, Trash2, X,
		ChevronDown, Sun, Moon, Save, LayoutGrid, GitBranch,
		Circle, Target, Sparkles, Lightbulb,
		Share2, Server, Globe, MonitorSmartphone, Cpu, CircleOff
	} from 'lucide-svelte';
	import * as Select from '$lib/components/ui/select';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import * as Dialog from '$lib/components/ui/dialog';

	interface Props {
		composeContent: string;
		class?: string;
		onContentChange?: (content: string) => void;
		readonly?: boolean;
	}

	let { composeContent, class: className = '', onContentChange, readonly = false }: Props = $props();

	let containerEl: HTMLDivElement | null = $state(null);
	let cy: cytoscape.Core | null = null;
	let graphInitialized = $state(false);
	let parseError = $state<string | null>(null);
	let selectedNode = $state<any>(null);
	let selectedEdge = $state<any>(null);

	// Theme state
	let graphTheme = $state<'light' | 'dark'>('light');

	// Layout state
	type LayoutType = 'breadthfirst' | 'grid' | 'circle' | 'concentric' | 'cose';
	let currentLayout = $state<LayoutType>('breadthfirst');
	let showLayoutMenu = $state(false);

	const layoutOptions: { value: LayoutType; label: string; icon: string }[] = [
		{ value: 'breadthfirst', label: 'Tree', icon: 'tree' },
		{ value: 'grid', label: 'Grid', icon: 'grid' },
		{ value: 'circle', label: 'Circle', icon: 'circle' },
		{ value: 'concentric', label: 'Radial', icon: 'radial' },
		{ value: 'cose', label: 'Force', icon: 'force' }
	];

	// Connection mode state (for service dependencies)
	let connectionMode = $state(false);
	let connectionSource = $state<string | null>(null);

	// Mount mode state (for volume/config/secret to service connections)
	let mountMode = $state(false);
	let mountSource = $state<{ name: string; type: 'volume' | 'network' | 'config' | 'secret' } | null>(null);

	// Add element dialog state
	let showAddDialog = $state(false);
	let addElementType = $state<'service' | 'network' | 'volume' | 'config' | 'secret'>('service');
	let newElementName = $state('');
	let newServiceImage = $state('');
	let newServicePorts = $state('');

	// Add menu dropdown
	let showAddMenu = $state(false);

	// Store the parsed compose object for modifications
	let composeData = $state<ComposeFile | null>(null);

	// Service edit state
	let editServiceImage = $state('');
	let editServiceCommand = $state('');
	let editServiceRestart = $state('no');
	let editServicePorts = $state<{ host: string; container: string; protocol: string }[]>([]);
	let editServiceVolumes = $state<{ host: string; container: string; mode: string }[]>([]);
	let editServiceEnvVars = $state<{ key: string; value: string }[]>([]);
	let editServiceLabels = $state<{ key: string; value: string }[]>([]);
	let editServiceNetworks = $state<string[]>([]);
	let serviceEditDirty = $state(false);

	// Network edit state
	let editNetworkDriver = $state('bridge');
	let editNetworkInternal = $state(false);
	let editNetworkExternal = $state(false);
	let editNetworkAttachable = $state(false);
	let editNetworkSubnet = $state('');
	let editNetworkGateway = $state('');
	let editNetworkLabels = $state<{ key: string; value: string }[]>([]);
	let editNetworkOptions = $state<{ key: string; value: string }[]>([]);
	let networkEditDirty = $state(false);

	// Volume edit state
	let editVolumeDriver = $state('local');
	let editVolumeExternal = $state(false);
	let editVolumeLabels = $state<{ key: string; value: string }[]>([]);
	let editVolumeOptions = $state<{ key: string; value: string }[]>([]);
	let volumeEditDirty = $state(false);

	// Config edit state
	let editConfigFile = $state('');
	let editConfigContent = $state('');
	let editConfigEnvironment = $state('');
	let editConfigExternal = $state(false);
	let editConfigName = $state('');
	let configEditDirty = $state(false);

	// Secret edit state
	let editSecretFile = $state('');
	let editSecretEnvironment = $state('');
	let editSecretExternal = $state(false);
	let editSecretName = $state('');
	let secretEditDirty = $state(false);


	interface ComposeFile {
		version?: string;
		name?: string;
		services?: Record<string, any>;
		networks?: Record<string, any>;
		volumes?: Record<string, any>;
		configs?: Record<string, any>;
		secrets?: Record<string, any>;
	}

	function parseCompose(content: string): ComposeFile | null {
		try {
			const parsed = yaml.load(content) as ComposeFile;
			parseError = null;
			return parsed;
		} catch (e: any) {
			parseError = e.message;
			// Try to parse partially - extract what we can from the YAML
			// by attempting to parse line by line and building a partial result
			return tryPartialParse(content, e);
		}
	}

	function tryPartialParse(content: string, originalError: any): ComposeFile | null {
		// Try to extract valid YAML sections before the error point
		const lines = content.split('\n');
		const errorMatch = originalError.message.match(/at line (\d+)/);
		const errorLine = errorMatch ? parseInt(errorMatch[1]) : lines.length;

		// Try parsing progressively smaller chunks until we find valid YAML
		for (let i = errorLine - 1; i > 0; i--) {
			const partialContent = lines.slice(0, i).join('\n');
			try {
				const partial = yaml.load(partialContent) as ComposeFile;
				if (partial && (partial.services || partial.networks || partial.volumes)) {
					// We found a valid partial - update error message
					parseError = `${originalError.message} (showing partial graph)`;
					return partial;
				}
			} catch {
				// Continue trying with fewer lines
			}
		}

		// If nothing worked, try to parse with js-yaml's lenient options
		try {
			const lenient = yaml.load(content, { json: true }) as ComposeFile;
			if (lenient && typeof lenient === 'object') {
				parseError = `${originalError.message} (showing partial graph)`;
				return lenient;
			}
		} catch {
			// Still failed
		}

		// Return an empty compose file so we at least show an empty graph with the error
		return { services: {}, networks: {}, volumes: {} };
	}

	function generateYaml(compose: ComposeFile): string {
		// Clean up empty sections
		const cleanCompose: ComposeFile = { ...compose };
		if (cleanCompose.services && Object.keys(cleanCompose.services).length === 0) {
			delete cleanCompose.services;
		}
		if (cleanCompose.networks && Object.keys(cleanCompose.networks).length === 0) {
			delete cleanCompose.networks;
		}
		if (cleanCompose.volumes && Object.keys(cleanCompose.volumes).length === 0) {
			delete cleanCompose.volumes;
		}
		if (cleanCompose.configs && Object.keys(cleanCompose.configs).length === 0) {
			delete cleanCompose.configs;
		}
		if (cleanCompose.secrets && Object.keys(cleanCompose.secrets).length === 0) {
			delete cleanCompose.secrets;
		}

		return yaml.dump(cleanCompose, {
			indent: 2,
			lineWidth: -1,
			noRefs: true,
			sortKeys: false
		});
	}

	function emitChange() {
		if (composeData && onContentChange) {
			const newYaml = generateYaml(composeData);
			onContentChange(newYaml);
		}
	}

	function buildGraphElements(compose: ComposeFile) {
		const elements: cytoscape.ElementDefinition[] = [];
		const services = compose.services || {};
		const networks = compose.networks || {};
		const volumes = compose.volumes || {};
		const configs = compose.configs || {};
		const secrets = compose.secrets || {};

		// Add service nodes
		Object.entries(services).forEach(([name, config]) => {
			const ports = config.ports || [];
			const envVars = config.environment || {};
			const envCount = Array.isArray(envVars) ? envVars.length : Object.keys(envVars).length;
			const dependsOn = config.depends_on
				? (Array.isArray(config.depends_on) ? config.depends_on : Object.keys(config.depends_on))
				: [];
			const imageStr = config.image || (config.build ? 'build' : 'custom');
			// Truncate long image names
			const shortImage = imageStr.length > 25 ? imageStr.substring(0, 22) + '...' : imageStr;

			elements.push({
				data: {
					id: `service-${name}`,
					label: name,
					caption: shortImage,
					type: 'service',
					image: config.image || config.build || 'custom',
					ports: ports.map((p: any) => typeof p === 'string' ? p : `${p.published}:${p.target}`),
					envCount,
					replicas: config.deploy?.replicas || 1,
					restart: config.restart || 'no',
					healthcheck: !!config.healthcheck,
					dependsOn,
					config: config
				}
			});

			// Add depends_on edges (with error detection for missing services)
			dependsOn.forEach((dep: string) => {
				const depExists = services[dep] !== undefined;
				elements.push({
					data: {
						id: `dep-${name}-${dep}`,
						source: `service-${dep}`,
						target: `service-${name}`,
						type: 'dependency',
						label: 'depends on',
						isError: !depExists,
						missingTarget: !depExists ? dep : undefined
					}
				});
			});

			// Add links edges (legacy)
			if (config.links) {
				config.links.forEach((link: string) => {
					const linkName = link.split(':')[0];
					elements.push({
						data: {
							id: `link-${name}-${linkName}`,
							source: `service-${linkName}`,
							target: `service-${name}`,
							type: 'link',
							label: 'links'
						}
					});
				});
			}
		});

		// Add ghost nodes for missing dependencies
		const missingServices = new Set<string>();
		Object.entries(services).forEach(([name, config]) => {
			const dependsOn = config.depends_on
				? (Array.isArray(config.depends_on) ? config.depends_on : Object.keys(config.depends_on))
				: [];
			dependsOn.forEach((dep: string) => {
				if (!services[dep] && !missingServices.has(dep)) {
					missingServices.add(dep);
					elements.push({
						data: {
							id: `service-${dep}`,
							label: dep,
							caption: 'missing',
							type: 'service',
							isMissing: true,
							image: '',
							ports: [],
							envCount: 0,
							replicas: 0,
							restart: 'no',
							healthcheck: false,
							dependsOn: [],
							config: {}
						}
					});
				}
			});
		});

		// Add network nodes
		Object.entries(networks).forEach(([name, config]) => {
			const driver = (config as any)?.driver || 'bridge';
			elements.push({
				data: {
					id: `network-${name}`,
					label: name,
					caption: driver,
					type: 'network',
					driver: driver,
					external: (config as any)?.external || false,
					config: config
				}
			});
		});

		// Connect services to networks
		Object.entries(services).forEach(([serviceName, config]) => {
			const serviceNetworks = config.networks;
			if (serviceNetworks) {
				const netNames = Array.isArray(serviceNetworks)
					? serviceNetworks
					: Object.keys(serviceNetworks);
				netNames.forEach((netName: string) => {
					if (networks[netName] || netName === 'default') {
						const targetId = networks[netName] ? `network-${netName}` : 'network-default';
						if (netName === 'default' && !networks['default']) {
							const defaultExists = elements.find(e => e.data.id === 'network-default');
							if (!defaultExists) {
								elements.push({
									data: {
										id: 'network-default',
										label: 'default',
										type: 'network',
										driver: 'bridge',
										external: false
									}
								});
							}
						}
						elements.push({
							data: {
								id: `net-${serviceName}-${netName}`,
								source: `service-${serviceName}`,
								target: targetId,
								type: 'network-connection'
							}
						});
					}
				});
			}
		});

		// Add volume nodes
		Object.entries(volumes).forEach(([name, config]) => {
			const driver = (config as any)?.driver || 'local';
			elements.push({
				data: {
					id: `volume-${name}`,
					label: name,
					caption: driver,
					type: 'volume',
					driver: driver,
					external: (config as any)?.external || false,
					config: config
				}
			});
		});

		// Connect services to volumes
		Object.entries(services).forEach(([serviceName, config]) => {
			if (config.volumes) {
				config.volumes.forEach((vol: any, idx: number) => {
					const volName = typeof vol === 'string' ? vol.split(':')[0] : vol.source;
					if (volumes[volName]) {
						elements.push({
							data: {
								id: `vol-${serviceName}-${volName}-${idx}`,
								source: `service-${serviceName}`,
								target: `volume-${volName}`,
								type: 'volume-mount'
							}
						});
					}
				});
			}
		});

		// Add config nodes
		Object.entries(configs).forEach(([name, config]) => {
			elements.push({
				data: {
					id: `config-${name}`,
					label: name,
					caption: 'config',
					type: 'config',
					external: (config as any)?.external || false,
					config: config
				}
			});
		});

		// Connect services to configs
		Object.entries(services).forEach(([serviceName, config]) => {
			if (config.configs) {
				config.configs.forEach((cfg: any, idx: number) => {
					const cfgName = typeof cfg === 'string' ? cfg : cfg.source;
					if (configs[cfgName]) {
						elements.push({
							data: {
								id: `cfg-${serviceName}-${cfgName}-${idx}`,
								source: `config-${cfgName}`,
								target: `service-${serviceName}`,
								type: 'config-mount'
							}
						});
					}
				});
			}
		});

		// Add secret nodes
		Object.entries(secrets).forEach(([name, config]) => {
			elements.push({
				data: {
					id: `secret-${name}`,
					label: name,
					caption: 'secret',
					type: 'secret',
					external: (config as any)?.external || false,
					config: config
				}
			});
		});

		// Connect services to secrets
		Object.entries(services).forEach(([serviceName, config]) => {
			if (config.secrets) {
				config.secrets.forEach((sec: any, idx: number) => {
					const secName = typeof sec === 'string' ? sec : sec.source;
					if (secrets[secName]) {
						elements.push({
							data: {
								id: `sec-${serviceName}-${secName}-${idx}`,
								source: `secret-${secName}`,
								target: `service-${serviceName}`,
								type: 'secret-mount'
							}
						});
					}
				});
			}
		});

		return elements;
	}

	// SVG icons as data URLs for nodes
	function getSvgIcon(type: string, color: string): string {
		const icons: Record<string, string> = {
			service: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg>`,
			network: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="16" y="16" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="9" y="2" width="6" height="6" rx="1"/><path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3"/><path d="M12 12V8"/></svg>`,
			volume: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" x2="2" y1="12" y2="12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><line x1="6" x2="6.01" y1="16" y2="16"/><line x1="10" x2="10.01" y1="16" y2="16"/></svg>`,
			config: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/></svg>`,
			secret: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`
		};
		const svg = icons[type] || icons.service;
		return `data:image/svg+xml,${encodeURIComponent(svg)}`;
	}

	function createGraph(useExistingData = false, skipLayout = false) {
		if (!containerEl) return;

		// Use existing composeData if requested (for local edits), otherwise parse from prop
		if (!useExistingData || !composeData) {
			composeData = parseCompose(composeContent);
		}
		// Even if parsing failed, we get at least an empty structure to render
		if (!composeData) {
			composeData = { services: {}, networks: {}, volumes: {} };
		}

		const elements = buildGraphElements(composeData);

		// If skipping layout, store current positions before destroying
		let savedPositions: Map<string, { x: number; y: number }> | null = null;
		if (skipLayout && cy) {
			savedPositions = new Map();
			cy.nodes().forEach((node) => {
				const pos = node.position();
				savedPositions!.set(node.id(), { x: pos.x, y: pos.y });
			});
		}

		if (cy) {
			cy.destroy();
		}

		// Theme-based colors
		const isDark = graphTheme === 'dark';
		const colors = {
			service: { bg: isDark ? '#3b82f6' : '#dbeafe', border: isDark ? '#2563eb' : '#93c5fd', text: isDark ? '#ffffff' : '#1e3a5f', icon: isDark ? '#ffffff' : '#2563eb' },
			network: { bg: isDark ? '#8b5cf6' : '#ede9fe', border: isDark ? '#7c3aed' : '#c4b5fd', text: isDark ? '#ffffff' : '#3b1e5f', icon: isDark ? '#ffffff' : '#7c3aed' },
			volume: { bg: isDark ? '#10b981' : '#dcfce7', border: isDark ? '#059669' : '#86efac', text: isDark ? '#ffffff' : '#14532d', icon: isDark ? '#ffffff' : '#059669' },
			config: { bg: isDark ? '#f59e0b' : '#fef3c7', border: isDark ? '#d97706' : '#fde68a', text: isDark ? '#1f2937' : '#713f12', icon: isDark ? '#1f2937' : '#d97706' },
			secret: { bg: isDark ? '#ef4444' : '#fee2e2', border: isDark ? '#dc2626' : '#fca5a5', text: isDark ? '#ffffff' : '#7f1d1d', icon: isDark ? '#ffffff' : '#dc2626' },
			edge: isDark ? '#64748b' : '#94a3b8',
			selected: isDark ? '#fbbf24' : '#18181b',
			caption: isDark ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.5)'
		};

		cy = cytoscape({
			container: containerEl,
			elements,
			style: [
				// Service nodes
				{
					selector: 'node[type="service"]',
					style: {
						'background-color': colors.service.bg,
						'border-color': colors.service.border,
						'border-width': 2,
						'label': (ele: any) => `${ele.data('label')}\n${ele.data('caption') || ''}`,
						'color': colors.service.text,
						'text-valign': 'center',
						'text-halign': 'center',
						'font-size': '10px',
						'font-weight': '600',
						'width': 150,
						'height': 55,
						'shape': 'roundrectangle',
						'text-wrap': 'wrap',
						'text-max-width': '115px',
						'text-overflow-wrap': 'anywhere',
						'line-height': 1.2,
						'background-image': getSvgIcon('service', colors.service.icon),
						'background-width': '16px',
						'background-height': '16px',
						'background-position-x': '8px',
						'background-position-y': '50%',
						'background-clip': 'none',
						'text-margin-x': 10
					}
				},
				// Missing service nodes (ghost nodes for failed dependencies)
				{
					selector: 'node[type="service"][?isMissing]',
					style: {
						'background-color': isDark ? '#7f1d1d' : '#fecaca',
						'border-color': '#ef4444',
						'border-width': 3,
						'border-style': 'dashed',
						'opacity': 0.85,
						'label': (ele: any) => `${ele.data('label')}\nmissing`,
						'color': isDark ? '#fca5a5' : '#7f1d1d',
						'text-valign': 'center',
						'text-halign': 'center',
						'font-size': '10px',
						'font-weight': '600',
						'width': 150,
						'height': 55,
						'shape': 'roundrectangle',
						'text-wrap': 'wrap',
						'text-max-width': '115px',
						'text-overflow-wrap': 'anywhere',
						'line-height': 1.2,
						'background-image': getSvgIcon('service', '#ef4444'),
						'background-width': '16px',
						'background-height': '16px',
						'background-position-x': '8px',
						'background-position-y': '50%',
						'background-clip': 'none',
						'text-margin-x': 10
					}
				},
				// Network nodes
				{
					selector: 'node[type="network"]',
					style: {
						'background-color': colors.network.bg,
						'border-color': colors.network.border,
						'border-width': 2,
						'label': (ele: any) => `${ele.data('label')}\nnetwork: ${ele.data('caption') || 'bridge'}`,
						'color': colors.network.text,
						'text-valign': 'center',
						'text-halign': 'center',
						'font-size': '9px',
						'font-weight': '600',
						'width': 120,
						'height': 46,
						'shape': 'roundrectangle',
						'text-wrap': 'wrap',
						'text-max-width': '90px',
						'text-overflow-wrap': 'anywhere',
						'line-height': 1.2,
						'background-image': getSvgIcon('network', colors.network.icon),
						'background-width': '14px',
						'background-height': '14px',
						'background-position-x': '6px',
						'background-position-y': '50%',
						'background-clip': 'none',
						'text-margin-x': 8
					}
				},
				// Volume nodes
				{
					selector: 'node[type="volume"]',
					style: {
						'background-color': colors.volume.bg,
						'border-color': colors.volume.border,
						'border-width': 2,
						'label': (ele: any) => `${ele.data('label')}\nvolume: ${ele.data('caption') || 'local'}`,
						'color': colors.volume.text,
						'text-valign': 'center',
						'text-halign': 'center',
						'font-size': '9px',
						'font-weight': '600',
						'width': 120,
						'height': 46,
						'shape': 'roundrectangle',
						'text-wrap': 'wrap',
						'text-max-width': '90px',
						'text-overflow-wrap': 'anywhere',
						'line-height': 1.2,
						'background-image': getSvgIcon('volume', colors.volume.icon),
						'background-width': '14px',
						'background-height': '14px',
						'background-position-x': '6px',
						'background-position-y': '50%',
						'background-clip': 'none',
						'text-margin-x': 8
					}
				},
				// Config nodes
				{
					selector: 'node[type="config"]',
					style: {
						'background-color': colors.config.bg,
						'border-color': colors.config.border,
						'border-width': 2,
						'label': (ele: any) => `${ele.data('label')}\nconfig`,
						'color': colors.config.text,
						'text-valign': 'center',
						'text-halign': 'center',
						'font-size': '9px',
						'font-weight': '600',
						'width': 100,
						'height': 42,
						'shape': 'roundrectangle',
						'text-wrap': 'wrap',
						'text-max-width': '75px',
						'text-overflow-wrap': 'anywhere',
						'line-height': 1.2,
						'background-image': getSvgIcon('config', colors.config.icon),
						'background-width': '14px',
						'background-height': '14px',
						'background-position-x': '6px',
						'background-position-y': '50%',
						'background-clip': 'none',
						'text-margin-x': 8
					}
				},
				// Secret nodes
				{
					selector: 'node[type="secret"]',
					style: {
						'background-color': colors.secret.bg,
						'border-color': colors.secret.border,
						'border-width': 2,
						'label': (ele: any) => `${ele.data('label')}\nsecret`,
						'color': colors.secret.text,
						'text-valign': 'center',
						'text-halign': 'center',
						'font-size': '9px',
						'font-weight': '600',
						'width': 100,
						'height': 42,
						'shape': 'roundrectangle',
						'text-wrap': 'wrap',
						'text-max-width': '75px',
						'text-overflow-wrap': 'anywhere',
						'line-height': 1.2,
						'background-image': getSvgIcon('secret', colors.secret.icon),
						'background-width': '14px',
						'background-height': '14px',
						'background-position-x': '6px',
						'background-position-y': '50%',
						'background-clip': 'none',
						'text-margin-x': 8
					}
				},
				// Dependency edges
				{
					selector: 'edge[type="dependency"]',
					style: {
						'width': 2,
						'line-color': '#94a3b8',
						'target-arrow-color': '#94a3b8',
						'target-arrow-shape': 'triangle',
						'curve-style': 'bezier',
						'arrow-scale': 1.2
					}
				},
				// Error dependency edges (missing target service)
				{
					selector: 'edge[type="dependency"][?isError]',
					style: {
						'width': 2.5,
						'line-color': '#ef4444',
						'target-arrow-color': '#ef4444',
						'target-arrow-shape': 'triangle',
						'curve-style': 'bezier',
						'line-style': 'dashed',
						'arrow-scale': 1.3
					}
				},
				// Link edges
				{
					selector: 'edge[type="link"]',
					style: {
						'width': 2,
						'line-color': '#64748b',
						'target-arrow-color': '#64748b',
						'target-arrow-shape': 'triangle',
						'curve-style': 'bezier',
						'line-style': 'dashed'
					}
				},
				// Network connection edges
				{
					selector: 'edge[type="network-connection"]',
					style: {
						'width': 1.5,
						'line-color': '#a78bfa',
						'curve-style': 'bezier',
						'line-style': 'dotted'
					}
				},
				// Volume mount edges
				{
					selector: 'edge[type="volume-mount"]',
					style: {
						'width': 1.5,
						'line-color': '#34d399',
						'curve-style': 'bezier',
						'line-style': 'dotted'
					}
				},
				// Config mount edges
				{
					selector: 'edge[type="config-mount"]',
					style: {
						'width': 1.5,
						'line-color': '#fbbf24',
						'target-arrow-color': '#fbbf24',
						'target-arrow-shape': 'triangle',
						'curve-style': 'bezier',
						'arrow-scale': 0.8
					}
				},
				// Secret mount edges
				{
					selector: 'edge[type="secret-mount"]',
					style: {
						'width': 1.5,
						'line-color': '#f87171',
						'target-arrow-color': '#f87171',
						'target-arrow-shape': 'triangle',
						'curve-style': 'bezier',
						'arrow-scale': 0.8
					}
				},
				// Selected node
				{
					selector: 'node:selected',
					style: {
						'border-width': 3,
						'border-color': '#18181b',
						'overlay-color': '#18181b',
						'overlay-padding': 3,
						'overlay-opacity': 0.15
					}
				},
				// Selected edge
				{
					selector: 'edge:selected',
					style: {
						'width': 3,
						'line-color': '#f59e0b',
						'target-arrow-color': '#f59e0b'
					}
				},
				// Connection mode - highlight services
				{
					selector: 'node.connection-source',
					style: {
						'border-width': 4,
						'border-color': '#22c55e',
						'overlay-color': '#22c55e',
						'overlay-padding': 5,
						'overlay-opacity': 0.3
					}
				},
				{
					selector: 'node.connection-target',
					style: {
						'border-color': '#3b82f6',
						'border-width': 3,
						'overlay-color': '#3b82f6',
						'overlay-padding': 3,
						'overlay-opacity': 0.2
					}
				},
				// Mount mode - highlight source (volume/network/config/secret)
				{
					selector: 'node.mount-source',
					style: {
						'border-width': 4,
						'border-color': '#10b981',
						'overlay-color': '#10b981',
						'overlay-padding': 5,
						'overlay-opacity': 0.3
					}
				},
				{
					selector: 'node.mount-target',
					style: {
						'border-color': '#10b981',
						'border-width': 3,
						'overlay-color': '#10b981',
						'overlay-padding': 3,
						'overlay-opacity': 0.2
					}
				}
			],
			layout: skipLayout && savedPositions ? { name: 'preset' } : {
				name: 'breadthfirst',
				directed: true,
				padding: 50,
				spacingFactor: 1.5,
				avoidOverlap: true,
				nodeDimensionsIncludeLabels: true
			},
			wheelSensitivity: 0.3,
			minZoom: 0.3,
			maxZoom: 3
		});

		// Restore saved positions if skipping layout
		if (skipLayout && savedPositions) {
			cy.nodes().forEach((node) => {
				const savedPos = savedPositions!.get(node.id());
				if (savedPos) {
					node.position(savedPos);
				}
			});
		}

		// Handle node selection
		cy.on('tap', 'node', (evt) => {
			const nodeData = evt.target.data();
			console.log('Node tapped:', nodeData);

			if (connectionMode && nodeData.type === 'service') {
				handleConnectionClick(nodeData);
			} else if (mountMode) {
				handleMountClick(nodeData);
			} else {
				selectedNode = nodeData;
				selectedEdge = null;
				console.log('selectedNode set to:', selectedNode);
			}
		});

		// Handle edge selection
		cy.on('tap', 'edge', (evt) => {
			selectedEdge = evt.target.data();
			selectedNode = null;
		});

		cy.on('tap', (evt) => {
			if (evt.target === cy) {
				selectedNode = null;
				selectedEdge = null;
				if (connectionMode) {
					cancelConnectionMode();
				}
				if (mountMode) {
					cancelMountMode();
				}
			}
		});

		graphInitialized = true;

		// Ensure the graph renders correctly after container is sized
		setTimeout(() => {
			if (cy) {
				cy.resize();
				cy.fit(undefined, 50);
			}
		}, 100);
	}

	function handleConnectionClick(nodeData: any) {
		if (!cy || !composeData) return;

		const serviceName = nodeData.label;

		if (!connectionSource) {
			// First click - set source
			connectionSource = serviceName;
			cy.$(`#service-${serviceName}`).addClass('connection-source');
			// Highlight potential targets
			cy.$('node[type="service"]').forEach((node) => {
				if (node.data('label') !== serviceName) {
					node.addClass('connection-target');
				}
			});
		} else {
			// Second click - create dependency
			const targetService = serviceName;

			if (connectionSource !== targetService) {
				addDependency(connectionSource, targetService);
			}

			cancelConnectionMode();
		}
	}

	function cancelConnectionMode() {
		connectionMode = false;
		connectionSource = null;
		if (cy) {
			cy.$('.connection-source').removeClass('connection-source');
			cy.$('.connection-target').removeClass('connection-target');
		}
	}

	function toggleConnectionMode() {
		if (connectionMode) {
			cancelConnectionMode();
		} else {
			// Cancel mount mode if active
			if (mountMode) cancelMountMode();
			connectionMode = true;
			selectedNode = null;
			selectedEdge = null;
		}
	}

	function handleMountClick(nodeData: any) {
		if (!cy || !composeData) return;

		const nodeType = nodeData.type;
		const nodeName = nodeData.label;

		if (!mountSource) {
			// First click - must be a volume, network, config, or secret
			if (['volume', 'network', 'config', 'secret'].includes(nodeType)) {
				mountSource = { name: nodeName, type: nodeType };
				cy.$(`#${nodeType}-${nodeName}`).addClass('mount-source');
				// Highlight services as potential targets
				cy.$('node[type="service"]').forEach((node) => {
					node.addClass('mount-target');
				});
			}
		} else {
			// Second click - must be a service
			if (nodeType === 'service') {
				addMount(mountSource.name, mountSource.type, nodeName);
			}
			cancelMountMode();
		}
	}

	function cancelMountMode() {
		mountMode = false;
		mountSource = null;
		if (cy) {
			cy.$('.mount-source').removeClass('mount-source');
			cy.$('.mount-target').removeClass('mount-target');
		}
	}

	function toggleMountMode() {
		if (mountMode) {
			cancelMountMode();
		} else {
			// Cancel connection mode if active
			if (connectionMode) cancelConnectionMode();
			mountMode = true;
			selectedNode = null;
			selectedEdge = null;
		}
	}

	function addMount(sourceName: string, sourceType: 'volume' | 'network' | 'config' | 'secret', targetService: string) {
		if (!composeData?.services?.[targetService]) return;

		const service = composeData.services[targetService];

		if (sourceType === 'volume') {
			if (!service.volumes) service.volumes = [];
			const mountPath = `/${sourceName}`;
			const volumeMount = `${sourceName}:${mountPath}`;
			if (!service.volumes.includes(volumeMount) && !service.volumes.some((v: any) =>
				typeof v === 'string' ? v.startsWith(`${sourceName}:`) : v.source === sourceName
			)) {
				service.volumes.push(volumeMount);
			}
		} else if (sourceType === 'network') {
			if (!service.networks) service.networks = [];
			if (Array.isArray(service.networks)) {
				if (!service.networks.includes(sourceName)) {
					service.networks.push(sourceName);
				}
			} else {
				if (!service.networks[sourceName]) {
					service.networks[sourceName] = {};
				}
			}
		} else if (sourceType === 'config') {
			if (!service.configs) service.configs = [];
			if (!service.configs.includes(sourceName) && !service.configs.some((c: any) =>
				typeof c === 'string' ? c === sourceName : c.source === sourceName
			)) {
				service.configs.push(sourceName);
			}
		} else if (sourceType === 'secret') {
			if (!service.secrets) service.secrets = [];
			if (!service.secrets.includes(sourceName) && !service.secrets.some((s: any) =>
				typeof s === 'string' ? s === sourceName : s.source === sourceName
			)) {
				service.secrets.push(sourceName);
			}
		}

		composeData = { ...composeData };
		emitChange();
		createGraph(true, true);
	}

	function addDependency(sourceService: string, targetService: string) {
		if (!composeData?.services) return;

		// Add depends_on to target service
		if (!composeData.services[targetService]) return;

		if (!composeData.services[targetService].depends_on) {
			composeData.services[targetService].depends_on = [];
		}

		const deps = composeData.services[targetService].depends_on;
		if (Array.isArray(deps) && !deps.includes(sourceService)) {
			deps.push(sourceService);
			// Force reactivity by reassigning composeData
			composeData = { ...composeData };
			emitChange();
			createGraph(true, true); // Refresh graph using local data
		}
	}

	function removeDependency(sourceService: string, targetService: string) {
		if (!composeData?.services?.[targetService]?.depends_on) return;

		const deps = composeData.services[targetService].depends_on;
		if (Array.isArray(deps)) {
			const idx = deps.indexOf(sourceService);
			if (idx > -1) {
				deps.splice(idx, 1);
				if (deps.length === 0) {
					delete composeData.services[targetService].depends_on;
				}
				// Force reactivity by reassigning composeData
				composeData = { ...composeData };
				emitChange();
				createGraph(true, true);
				selectedEdge = null;
			}
		}
	}

	function openAddDialog(type: 'service' | 'network' | 'volume' | 'config' | 'secret') {
		addElementType = type;
		newElementName = '';
		newServiceImage = '';
		newServicePorts = '';
		showAddDialog = true;
		showAddMenu = false;
	}

	function addElement() {
		if (!composeData || !newElementName.trim()) return;

		const name = newElementName.trim().toLowerCase().replace(/\s+/g, '-');

		switch (addElementType) {
			case 'service':
				if (!composeData.services) composeData.services = {};
				composeData.services[name] = {
					image: newServiceImage || 'alpine:latest'
				};
				if (newServicePorts.trim()) {
					composeData.services[name].ports = newServicePorts.split(',').map(p => p.trim());
				}
				break;
			case 'network':
				if (!composeData.networks) composeData.networks = {};
				composeData.networks[name] = {
					driver: 'bridge'
				};
				break;
			case 'volume':
				if (!composeData.volumes) composeData.volumes = {};
				composeData.volumes[name] = {};
				break;
			case 'config':
				if (!composeData.configs) composeData.configs = {};
				composeData.configs[name] = {
					file: `./${name}.conf`
				};
				break;
			case 'secret':
				if (!composeData.secrets) composeData.secrets = {};
				composeData.secrets[name] = {
					file: `./${name}.secret`
				};
				break;
		}

		// Force reactivity by reassigning composeData
		composeData = { ...composeData };
		showAddDialog = false;
		emitChange();
		createGraph(true, true);
	}

	function deleteSelectedNode() {
		if (!selectedNode || !composeData) return;

		const { type, label } = selectedNode;

		switch (type) {
			case 'service':
				if (composeData.services) {
					delete composeData.services[label];
					// Also remove this service from other services' depends_on
					Object.values(composeData.services).forEach((svc: any) => {
						if (svc.depends_on && Array.isArray(svc.depends_on)) {
							const idx = svc.depends_on.indexOf(label);
							if (idx > -1) svc.depends_on.splice(idx, 1);
							if (svc.depends_on.length === 0) delete svc.depends_on;
						}
					});
				}
				break;
			case 'network':
				if (composeData.networks) delete composeData.networks[label];
				break;
			case 'volume':
				if (composeData.volumes) delete composeData.volumes[label];
				break;
			case 'config':
				if (composeData.configs) delete composeData.configs[label];
				break;
			case 'secret':
				if (composeData.secrets) delete composeData.secrets[label];
				break;
		}

		selectedNode = null;
		// Force reactivity by reassigning composeData
		composeData = { ...composeData };
		emitChange();
		createGraph(true, true);
	}

	function deleteSelectedEdge() {
		if (!selectedEdge || !composeData) return;

		const { type, source, target } = selectedEdge;

		if (type === 'dependency') {
			// Extract service names from node IDs
			const sourceService = source.replace('service-', '');
			const targetService = target.replace('service-', '');
			removeDependency(sourceService, targetService);
		} else if (type === 'network-connection') {
			// Remove network from service's networks list
			// Edge: source=service-X, target=network-Y
			const serviceName = source.replace('service-', '');
			const networkName = target.replace('network-', '');
			removeNetworkFromService(serviceName, networkName);
		} else if (type === 'volume-mount') {
			// Remove volume from service's volumes list
			// Edge: source=service-X, target=volume-Y
			const serviceName = source.replace('service-', '');
			const volumeName = target.replace('volume-', '');
			removeVolumeFromService(serviceName, volumeName);
		} else if (type === 'config-mount') {
			// Remove config from service's configs list
			// Edge: source=config-X, target=service-Y
			const serviceName = target.replace('service-', '');
			const configName = source.replace('config-', '');
			removeConfigFromService(serviceName, configName);
		} else if (type === 'secret-mount') {
			// Remove secret from service's secrets list
			// Edge: source=secret-X, target=service-Y
			const serviceName = target.replace('service-', '');
			const secretName = source.replace('secret-', '');
			removeSecretFromService(serviceName, secretName);
		}
	}

	function removeNetworkFromService(serviceName: string, networkName: string) {
		if (!composeData?.services?.[serviceName]) return;
		const service = composeData.services[serviceName];

		if (service.networks) {
			if (Array.isArray(service.networks)) {
				const idx = service.networks.indexOf(networkName);
				if (idx > -1) service.networks.splice(idx, 1);
				if (service.networks.length === 0) delete service.networks;
			} else if (typeof service.networks === 'object') {
				delete service.networks[networkName];
				if (Object.keys(service.networks).length === 0) delete service.networks;
			}
		}

		composeData = { ...composeData };
		emitChange();
		createGraph(true, true);
		selectedEdge = null;
	}

	function removeVolumeFromService(serviceName: string, volumeName: string) {
		if (!composeData?.services?.[serviceName]) return;
		const service = composeData.services[serviceName];

		if (service.volumes && Array.isArray(service.volumes)) {
			// Volume mounts can be strings like "volumeName:/path" or objects
			service.volumes = service.volumes.filter((v: any) => {
				if (typeof v === 'string') {
					return !v.startsWith(volumeName + ':') && v !== volumeName;
				} else if (typeof v === 'object' && v.source) {
					return v.source !== volumeName;
				}
				return true;
			});
			if (service.volumes.length === 0) delete service.volumes;
		}

		composeData = { ...composeData };
		emitChange();
		createGraph(true, true);
		selectedEdge = null;
	}

	function removeConfigFromService(serviceName: string, configName: string) {
		if (!composeData?.services?.[serviceName]) return;
		const service = composeData.services[serviceName];

		if (service.configs && Array.isArray(service.configs)) {
			service.configs = service.configs.filter((c: any) => {
				if (typeof c === 'string') return c !== configName;
				if (typeof c === 'object' && c.source) return c.source !== configName;
				return true;
			});
			if (service.configs.length === 0) delete service.configs;
		}

		composeData = { ...composeData };
		emitChange();
		createGraph(true, true);
		selectedEdge = null;
	}

	function removeSecretFromService(serviceName: string, secretName: string) {
		if (!composeData?.services?.[serviceName]) return;
		const service = composeData.services[serviceName];

		if (service.secrets && Array.isArray(service.secrets)) {
			service.secrets = service.secrets.filter((s: any) => {
				if (typeof s === 'string') return s !== secretName;
				if (typeof s === 'object' && s.source) return s.source !== secretName;
				return true;
			});
			if (service.secrets.length === 0) delete service.secrets;
		}

		composeData = { ...composeData };
		emitChange();
		createGraph(true, true);
		selectedEdge = null;
	}

	function zoomIn() {
		if (cy) cy.zoom(cy.zoom() * 1.2);
	}

	function zoomOut() {
		if (cy) cy.zoom(cy.zoom() / 1.2);
	}

	function fitToScreen() {
		if (cy) cy.fit(undefined, 50);
	}

	// Exported function to handle container resize
	export function resize() {
		if (cy && containerEl) {
			// Cytoscape caches container dimensions aggressively
			// We need to unmount and remount to the container
			cy!.unmount();

			// Wait for DOM to update
			requestAnimationFrame(() => {
				if (cy && containerEl) {
					cy!.mount(containerEl);
					cy!.resize();
					cy!.fit(undefined, 50);
				}
			});
		}
	}

	function getLayoutConfig(layoutName: LayoutType): cytoscape.LayoutOptions {
		const baseConfig = {
			padding: 50,
			avoidOverlap: true,
			nodeDimensionsIncludeLabels: true
		};

		switch (layoutName) {
			case 'breadthfirst':
				return {
					...baseConfig,
					name: 'breadthfirst',
					directed: true,
					spacingFactor: 1.5
				};
			case 'grid':
				return {
					...baseConfig,
					name: 'grid',
					rows: undefined,
					cols: undefined
				};
			case 'circle':
				return {
					...baseConfig,
					name: 'circle',
					spacingFactor: 1.2
				};
			case 'concentric':
				return {
					...baseConfig,
					name: 'concentric',
					minNodeSpacing: 50,
					concentric: (node: any) => {
						// Services at center, resources around
						return node.data('type') === 'service' ? 2 : 1;
					},
					levelWidth: () => 1
				};
			case 'cose':
				return {
					...baseConfig,
					name: 'cose',
					idealEdgeLength: () => 100,
					nodeOverlap: 20,
					animate: true,
					animationDuration: 500
				};
			default:
				return { ...baseConfig, name: layoutName };
		}
	}

	function applyLayout(layoutName: LayoutType) {
		if (!cy) return;
		currentLayout = layoutName;
		showLayoutMenu = false;
		cy.layout(getLayoutConfig(layoutName)).run();
		cy.fit(undefined, 50);
	}

	function resetLayout() {
		if (cy) {
			cy.layout(getLayoutConfig(currentLayout)).run();
			cy.fit(undefined, 50);
		}
	}

	onMount(() => {
		// Follow app theme from localStorage
		const appTheme = localStorage.getItem('theme');
		if (appTheme === 'dark' || appTheme === 'light') {
			graphTheme = appTheme;
		} else {
			// Fallback to system preference
			graphTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
		}
	});

	// Create graph when container element becomes available
	$effect(() => {
		if (containerEl && composeContent && !graphInitialized) {
			createGraph();
		}
	});

	onDestroy(() => {
		if (cy) {
			cy.destroy();
			cy = null;
		}
	});

	function toggleGraphTheme() {
		graphTheme = graphTheme === 'light' ? 'dark' : 'light';
		createGraph(true); // Recreate graph with new theme, preserve local edits
	}

	// Recreate graph when content changes externally
	let lastContent = composeContent;
	$effect(() => {
		if (containerEl && composeContent && composeContent !== lastContent) {
			lastContent = composeContent;
			createGraph();
		}
	});

	function getNodeIcon(type: string) {
		switch (type) {
			case 'service': return Box;
			case 'network': return Network;
			case 'volume': return HardDrive;
			case 'config': return FileText;
			case 'secret': return Lock;
			default: return Database;
		}
	}

	function getNodeColor(type: string) {
		switch (type) {
			case 'service': return 'bg-blue-500';
			case 'network': return 'bg-violet-500';
			case 'volume': return 'bg-emerald-500';
			case 'config': return 'bg-amber-500';
			case 'secret': return 'bg-red-500';
			default: return 'bg-slate-500';
		}
	}

	function getElementTypeLabel(type: string) {
		switch (type) {
			case 'service': return 'Service';
			case 'network': return 'Network';
			case 'volume': return 'Volume';
			case 'config': return 'Config';
			case 'secret': return 'Secret';
			default: return type;
		}
	}

	// Initialize edit state when a service is selected
	function initServiceEdit(nodeData: any) {
		if (!composeData?.services || nodeData.type !== 'service') return;

		const serviceName = nodeData.label;
		const config = composeData.services[serviceName];
		if (!config) return;

		editServiceImage = config.image || '';
		editServiceCommand = Array.isArray(config.command)
			? config.command.join(' ')
			: (config.command || '');
		editServiceRestart = config.restart || 'no';

		// Parse ports
		const ports = config.ports || [];
		editServicePorts = ports.map((p: any) => {
			if (typeof p === 'string') {
				const parts = p.split(':');
				const lastPart = parts[parts.length - 1];
				const protocolMatch = lastPart.match(/\/(\w+)$/);
				const protocol = protocolMatch ? protocolMatch[1] : 'tcp';
				const containerPort = lastPart.replace(/\/\w+$/, '');
				return {
					host: parts.length > 1 ? parts[0] : '',
					container: containerPort,
					protocol
				};
			}
			return {
				host: String(p.published || ''),
				container: String(p.target || ''),
				protocol: p.protocol || 'tcp'
			};
		});
		if (editServicePorts.length === 0) {
			editServicePorts = [{ host: '', container: '', protocol: 'tcp' }];
		}

		// Parse volumes
		const volumes = config.volumes || [];
		editServiceVolumes = volumes.map((v: any) => {
			if (typeof v === 'string') {
				const parts = v.split(':');
				return {
					host: parts[0] || '',
					container: parts[1] || '',
					mode: parts[2] || 'rw'
				};
			}
			return {
				host: v.source || '',
				container: v.target || '',
				mode: v.read_only ? 'ro' : 'rw'
			};
		});
		if (editServiceVolumes.length === 0) {
			editServiceVolumes = [{ host: '', container: '', mode: 'rw' }];
		}

		// Parse environment variables
		const env = config.environment || {};
		if (Array.isArray(env)) {
			editServiceEnvVars = env.map((e: string) => {
				const [key, ...valueParts] = e.split('=');
				return { key, value: valueParts.join('=') };
			});
		} else {
			editServiceEnvVars = Object.entries(env).map(([key, value]) => ({
				key,
				value: String(value)
			}));
		}
		if (editServiceEnvVars.length === 0) {
			editServiceEnvVars = [{ key: '', value: '' }];
		}

		// Parse labels
		const labels = config.labels || {};
		if (Array.isArray(labels)) {
			editServiceLabels = labels.map((l: string) => {
				const [key, ...valueParts] = l.split('=');
				return { key, value: valueParts.join('=') };
			});
		} else {
			editServiceLabels = Object.entries(labels).map(([key, value]) => ({
				key,
				value: String(value)
			}));
		}
		if (editServiceLabels.length === 0) {
			editServiceLabels = [{ key: '', value: '' }];
		}

		// Parse networks
		const networks = config.networks;
		if (networks) {
			editServiceNetworks = Array.isArray(networks) ? networks : Object.keys(networks);
		} else {
			editServiceNetworks = [];
		}

		serviceEditDirty = false;
	}

	// Save service edits back to compose data
	function saveServiceEdit() {
		if (!composeData?.services || !selectedNode || selectedNode.type !== 'service') return;

		const serviceName = selectedNode.label;
		if (!composeData.services[serviceName]) return;

		const config = composeData.services[serviceName];

		// Update image
		if (editServiceImage.trim()) {
			config.image = editServiceImage.trim();
		}

		// Update command
		if (editServiceCommand.trim()) {
			config.command = editServiceCommand.trim();
		} else {
			delete config.command;
		}

		// Update restart policy
		config.restart = editServiceRestart;

		// Update ports
		const validPorts = editServicePorts.filter(p => p.container);
		if (validPorts.length > 0) {
			config.ports = validPorts.map(p => {
				if (p.host) {
					return p.protocol !== 'tcp'
						? `${p.host}:${p.container}/${p.protocol}`
						: `${p.host}:${p.container}`;
				}
				return p.protocol !== 'tcp' ? `${p.container}/${p.protocol}` : p.container;
			});
		} else {
			delete config.ports;
		}

		// Update volumes
		const validVolumes = editServiceVolumes.filter(v => v.host && v.container);
		if (validVolumes.length > 0) {
			config.volumes = validVolumes.map(v =>
				v.mode === 'ro' ? `${v.host}:${v.container}:ro` : `${v.host}:${v.container}`
			);
		} else {
			delete config.volumes;
		}

		// Update environment variables
		const validEnvVars = editServiceEnvVars.filter(e => e.key);
		if (validEnvVars.length > 0) {
			config.environment = {};
			validEnvVars.forEach(e => {
				config.environment[e.key] = e.value;
			});
		} else {
			delete config.environment;
		}

		// Update labels
		const validLabels = editServiceLabels.filter(l => l.key);
		if (validLabels.length > 0) {
			config.labels = {};
			validLabels.forEach(l => {
				config.labels[l.key] = l.value;
			});
		} else {
			delete config.labels;
		}

		serviceEditDirty = false;
		// Force reactivity by reassigning composeData
		composeData = { ...composeData };
		emitChange();
		createGraph(true, true);
	}

	// Add/remove functions for service edit arrays
	function addServicePort() {
		editServicePorts = [...editServicePorts, { host: '', container: '', protocol: 'tcp' }];
		serviceEditDirty = true;
	}
	function removeServicePort(index: number) {
		editServicePorts = editServicePorts.filter((_, i) => i !== index);
		serviceEditDirty = true;
	}
	function addServiceVolume() {
		editServiceVolumes = [...editServiceVolumes, { host: '', container: '', mode: 'rw' }];
		serviceEditDirty = true;
	}
	function removeServiceVolume(index: number) {
		editServiceVolumes = editServiceVolumes.filter((_, i) => i !== index);
		serviceEditDirty = true;
	}
	function addServiceEnvVar() {
		editServiceEnvVars = [...editServiceEnvVars, { key: '', value: '' }];
		serviceEditDirty = true;
	}
	function removeServiceEnvVar(index: number) {
		editServiceEnvVars = editServiceEnvVars.filter((_, i) => i !== index);
		serviceEditDirty = true;
	}
	function addServiceLabel() {
		editServiceLabels = [...editServiceLabels, { key: '', value: '' }];
		serviceEditDirty = true;
	}
	function removeServiceLabel(index: number) {
		editServiceLabels = editServiceLabels.filter((_, i) => i !== index);
		serviceEditDirty = true;
	}
	function markServiceDirty() {
		serviceEditDirty = true;
	}

	// Effect to initialize edit state when service is selected
	// Use untrack to prevent tracking composeData inside init functions
	let lastSelectedNodeId: string | null = null;
	$effect(() => {
		const nodeId = selectedNode?.id ?? null;
		if (nodeId !== lastSelectedNodeId) {
			lastSelectedNodeId = nodeId;
			if (selectedNode) {
				untrack(() => {
					switch (selectedNode.type) {
						case 'service':
							initServiceEdit(selectedNode);
							break;
						case 'network':
							initNetworkEdit(selectedNode);
							break;
						case 'volume':
							initVolumeEdit(selectedNode);
							break;
						case 'config':
							initConfigEdit(selectedNode);
							break;
						case 'secret':
							initSecretEdit(selectedNode);
							break;
					}
				});
			}
		}
	});

	// Initialize network edit state
	function initNetworkEdit(nodeData: any) {
		if (!composeData?.networks || nodeData.type !== 'network') return;

		const networkName = nodeData.label;
		const config = composeData.networks[networkName] || {};

		editNetworkDriver = config.driver || 'bridge';
		editNetworkInternal = config.internal || false;
		editNetworkExternal = config.external || false;
		editNetworkAttachable = config.attachable || false;

		// Parse IPAM config
		const ipamConfig = config.ipam?.config?.[0] || {};
		editNetworkSubnet = ipamConfig.subnet || '';
		editNetworkGateway = ipamConfig.gateway || '';

		// Parse labels
		const labels = config.labels || {};
		if (typeof labels === 'object' && !Array.isArray(labels)) {
			editNetworkLabels = Object.entries(labels).map(([key, value]) => ({
				key,
				value: String(value)
			}));
		} else {
			editNetworkLabels = [];
		}
		if (editNetworkLabels.length === 0) {
			editNetworkLabels = [{ key: '', value: '' }];
		}

		// Parse driver options
		const options = config.driver_opts || {};
		if (typeof options === 'object' && !Array.isArray(options)) {
			editNetworkOptions = Object.entries(options).map(([key, value]) => ({
				key,
				value: String(value)
			}));
		} else {
			editNetworkOptions = [];
		}
		if (editNetworkOptions.length === 0) {
			editNetworkOptions = [{ key: '', value: '' }];
		}

		networkEditDirty = false;
	}

	// Save network edits
	function saveNetworkEdit() {
		if (!composeData?.networks || !selectedNode || selectedNode.type !== 'network') return;

		const networkName = selectedNode.label;
		if (!composeData.networks[networkName]) {
			composeData.networks[networkName] = {};
		}

		const config = composeData.networks[networkName];

		// Update driver
		if (editNetworkDriver !== 'bridge') {
			config.driver = editNetworkDriver;
		} else {
			delete config.driver;
		}

		// Update boolean flags
		if (editNetworkInternal) {
			config.internal = true;
		} else {
			delete config.internal;
		}

		if (editNetworkExternal) {
			config.external = true;
		} else {
			delete config.external;
		}

		if (editNetworkAttachable) {
			config.attachable = true;
		} else {
			delete config.attachable;
		}

		// Update IPAM config
		if (editNetworkSubnet || editNetworkGateway) {
			config.ipam = {
				config: [{
					...(editNetworkSubnet ? { subnet: editNetworkSubnet } : {}),
					...(editNetworkGateway ? { gateway: editNetworkGateway } : {})
				}]
			};
		} else {
			delete config.ipam;
		}

		// Update labels
		const validLabels = editNetworkLabels.filter(l => l.key);
		if (validLabels.length > 0) {
			config.labels = {};
			validLabels.forEach(l => {
				config.labels[l.key] = l.value;
			});
		} else {
			delete config.labels;
		}

		// Update driver options
		const validOptions = editNetworkOptions.filter(o => o.key);
		if (validOptions.length > 0) {
			config.driver_opts = {};
			validOptions.forEach(o => {
				config.driver_opts[o.key] = o.value;
			});
		} else {
			delete config.driver_opts;
		}

		networkEditDirty = false;
		// Force reactivity by reassigning composeData
		composeData = { ...composeData };
		emitChange();
		createGraph(true, true);
	}

	// Network edit helpers
	function addNetworkLabel() {
		editNetworkLabels = [...editNetworkLabels, { key: '', value: '' }];
		networkEditDirty = true;
	}
	function removeNetworkLabel(index: number) {
		editNetworkLabels = editNetworkLabels.filter((_, i) => i !== index);
		networkEditDirty = true;
	}
	function addNetworkOption() {
		editNetworkOptions = [...editNetworkOptions, { key: '', value: '' }];
		networkEditDirty = true;
	}
	function removeNetworkOption(index: number) {
		editNetworkOptions = editNetworkOptions.filter((_, i) => i !== index);
		networkEditDirty = true;
	}
	function markNetworkDirty() {
		networkEditDirty = true;
	}

	// Initialize volume edit state
	function initVolumeEdit(nodeData: any) {
		if (!composeData?.volumes || nodeData.type !== 'volume') return;

		const volumeName = nodeData.label;
		const config = composeData.volumes[volumeName] || {};

		editVolumeDriver = config.driver || 'local';
		editVolumeExternal = config.external || false;

		// Parse labels
		const labels = config.labels || {};
		if (typeof labels === 'object' && !Array.isArray(labels)) {
			editVolumeLabels = Object.entries(labels).map(([key, value]) => ({
				key,
				value: String(value)
			}));
		} else {
			editVolumeLabels = [];
		}
		if (editVolumeLabels.length === 0) {
			editVolumeLabels = [{ key: '', value: '' }];
		}

		// Parse driver options
		const options = config.driver_opts || {};
		if (typeof options === 'object' && !Array.isArray(options)) {
			editVolumeOptions = Object.entries(options).map(([key, value]) => ({
				key,
				value: String(value)
			}));
		} else {
			editVolumeOptions = [];
		}
		if (editVolumeOptions.length === 0) {
			editVolumeOptions = [{ key: '', value: '' }];
		}

		volumeEditDirty = false;
	}

	// Save volume edits
	function saveVolumeEdit() {
		if (!composeData?.volumes || !selectedNode || selectedNode.type !== 'volume') return;

		const volumeName = selectedNode.label;
		if (!composeData.volumes[volumeName]) {
			composeData.volumes[volumeName] = {};
		}

		const config = composeData.volumes[volumeName];

		// Update driver
		if (editVolumeDriver !== 'local') {
			config.driver = editVolumeDriver;
		} else {
			delete config.driver;
		}

		// Update external
		if (editVolumeExternal) {
			config.external = true;
		} else {
			delete config.external;
		}

		// Update labels
		const validLabels = editVolumeLabels.filter(l => l.key);
		if (validLabels.length > 0) {
			config.labels = {};
			validLabels.forEach(l => {
				config.labels[l.key] = l.value;
			});
		} else {
			delete config.labels;
		}

		// Update driver options
		const validOptions = editVolumeOptions.filter(o => o.key);
		if (validOptions.length > 0) {
			config.driver_opts = {};
			validOptions.forEach(o => {
				config.driver_opts[o.key] = o.value;
			});
		} else {
			delete config.driver_opts;
		}

		volumeEditDirty = false;
		// Force reactivity by reassigning composeData
		composeData = { ...composeData };
		emitChange();
		createGraph(true, true);
	}

	// Volume edit helpers
	function addVolumeLabel() {
		editVolumeLabels = [...editVolumeLabels, { key: '', value: '' }];
		volumeEditDirty = true;
	}
	function removeVolumeLabel(index: number) {
		editVolumeLabels = editVolumeLabels.filter((_, i) => i !== index);
		volumeEditDirty = true;
	}
	function addVolumeOption() {
		editVolumeOptions = [...editVolumeOptions, { key: '', value: '' }];
		volumeEditDirty = true;
	}
	function removeVolumeOption(index: number) {
		editVolumeOptions = editVolumeOptions.filter((_, i) => i !== index);
		volumeEditDirty = true;
	}
	function markVolumeDirty() {
		volumeEditDirty = true;
	}

	// Initialize config edit state
	function initConfigEdit(nodeData: any) {
		if (!composeData?.configs || nodeData.type !== 'config') return;

		const configName = nodeData.label;
		const config = composeData.configs[configName] || {};

		editConfigFile = config.file || '';
		editConfigContent = config.content || '';
		editConfigEnvironment = config.environment || '';
		editConfigExternal = config.external || false;
		editConfigName = config.name || '';

		configEditDirty = false;
	}

	// Save config edits
	function saveConfigEdit() {
		if (!composeData?.configs || !selectedNode || selectedNode.type !== 'config') return;

		const configName = selectedNode.label;
		if (!composeData.configs[configName]) {
			composeData.configs[configName] = {};
		}

		const config = composeData.configs[configName];

		// Clear all properties first
		delete config.file;
		delete config.content;
		delete config.environment;
		delete config.external;
		delete config.name;

		// Set based on what's provided
		if (editConfigExternal) {
			config.external = true;
			if (editConfigName) config.name = editConfigName;
		} else if (editConfigFile) {
			config.file = editConfigFile;
		} else if (editConfigContent) {
			config.content = editConfigContent;
		} else if (editConfigEnvironment) {
			config.environment = editConfigEnvironment;
		}

		configEditDirty = false;
		// Force reactivity by reassigning composeData
		composeData = { ...composeData };
		emitChange();
		createGraph(true, true);
	}

	function markConfigDirty() {
		configEditDirty = true;
	}

	// Initialize secret edit state
	function initSecretEdit(nodeData: any) {
		if (!composeData?.secrets || nodeData.type !== 'secret') return;

		const secretName = nodeData.label;
		const config = composeData.secrets[secretName] || {};

		editSecretFile = config.file || '';
		editSecretEnvironment = config.environment || '';
		editSecretExternal = config.external || false;
		editSecretName = config.name || '';

		secretEditDirty = false;
	}

	// Save secret edits
	function saveSecretEdit() {
		if (!composeData?.secrets || !selectedNode || selectedNode.type !== 'secret') return;

		const secretName = selectedNode.label;
		if (!composeData.secrets[secretName]) {
			composeData.secrets[secretName] = {};
		}

		const config = composeData.secrets[secretName];

		// Clear all properties first
		delete config.file;
		delete config.environment;
		delete config.external;
		delete config.name;

		// Set based on what's provided
		if (editSecretExternal) {
			config.external = true;
			if (editSecretName) config.name = editSecretName;
		} else if (editSecretFile) {
			config.file = editSecretFile;
		} else if (editSecretEnvironment) {
			config.environment = editSecretEnvironment;
		}

		secretEditDirty = false;
		// Force reactivity by reassigning composeData
		composeData = { ...composeData };
		emitChange();
		createGraph(true, true);
	}

	function markSecretDirty() {
		secretEditDirty = true;
	}

</script>

<div class="flex flex-col h-full {className}">
	<!-- Toolbar -->
	<div class="flex items-center justify-between px-2 py-1.5 border-b border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 min-h-[40px]">
		<div class="flex items-center gap-2 flex-wrap">
			{#if !readonly}
			<!-- Add element dropdown -->
			<div class="relative">
				<Button
					variant="outline"
					size="sm"
					class="h-6 px-2 text-xs gap-1"
					onclick={() => showAddMenu = !showAddMenu}
				>
					<Plus class="w-3 h-3" />
					Add
					<ChevronDown class="w-2.5 h-2.5" />
				</Button>

				{#if showAddMenu}
					<div class="absolute top-full left-0 mt-1 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-md shadow-lg z-50 py-1 min-w-[140px]">
						<button
							class="w-full px-2.5 py-1.5 text-left text-xs text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-700 flex items-center gap-2 transition-colors"
							onclick={() => openAddDialog('service')}
						>
							<Box class="w-3.5 h-3.5 text-blue-500" />
							Service
						</button>
						<button
							class="w-full px-2.5 py-1.5 text-left text-xs text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-700 flex items-center gap-2 transition-colors"
							onclick={() => openAddDialog('network')}
						>
							<Network class="w-3.5 h-3.5 text-violet-500" />
							Network
						</button>
						<button
							class="w-full px-2.5 py-1.5 text-left text-xs text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-700 flex items-center gap-2 transition-colors"
							onclick={() => openAddDialog('volume')}
						>
							<HardDrive class="w-3.5 h-3.5 text-emerald-500" />
							Volume
						</button>
						<button
							class="w-full px-2.5 py-1.5 text-left text-xs text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-700 flex items-center gap-2 transition-colors"
							onclick={() => openAddDialog('config')}
						>
							<FileText class="w-3.5 h-3.5 text-amber-500" />
							Config
						</button>
						<button
							class="w-full px-2.5 py-1.5 text-left text-xs text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-700 flex items-center gap-2 transition-colors"
							onclick={() => openAddDialog('secret')}
						>
							<Lock class="w-3.5 h-3.5 text-red-500" />
							Secret
						</button>
					</div>
				{/if}
			</div>

			<!-- Connection mode toggle -->
			<Button
				variant={connectionMode ? 'default' : 'outline'}
				size="sm"
				class="h-6 px-2 text-xs gap-1 w-[98px] justify-center"
				onclick={toggleConnectionMode}
			>
				<Link class="w-3 h-3" />
				{connectionMode ? 'Cancel' : 'Dependency'}
			</Button>

			<!-- Mount mode toggle (volume/network/config/secret to service) -->
			<Button
				variant={mountMode ? 'default' : 'outline'}
				size="sm"
				class="h-6 px-2 text-xs gap-1 w-[68px] justify-center"
				onclick={toggleMountMode}
			>
				<HardDrive class="w-3 h-3" />
				{mountMode ? 'Cancel' : 'Mount'}
			</Button>

			<!-- Hint when in connection/mount mode -->
			{#if connectionMode || mountMode}
				<div class="flex items-center gap-1.5 px-2 py-0.5 bg-amber-100 dark:bg-amber-900/30 text-amber-800 dark:text-amber-200 rounded text-xs">
					<Lightbulb class="w-3 h-3" />
					{#if connectionMode}
						{#if connectionSource}
							Click target service
						{:else}
							Click source service
						{/if}
					{:else if mountMode}
						{#if mountSource}
							Click target service
						{:else}
							Click volume/network/config/secret
						{/if}
					{/if}
				</div>
			{/if}
			{/if}
		</div>

		<!-- Controls -->
		<div class="flex items-center gap-0.5">
			<!-- Layout selector -->
			<div class="relative">
				<button
					onclick={() => showLayoutMenu = !showLayoutMenu}
					class="h-6 px-2 flex items-center gap-1 rounded text-xs text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors"
					title="Change layout"
				>
					{#if currentLayout === 'breadthfirst'}
						<GitBranch class="w-3 h-3" />
					{:else if currentLayout === 'grid'}
						<LayoutGrid class="w-3 h-3" />
					{:else if currentLayout === 'circle'}
						<Circle class="w-3 h-3" />
					{:else if currentLayout === 'concentric'}
						<Target class="w-3 h-3" />
					{:else}
						<Sparkles class="w-3 h-3" />
					{/if}
					<ChevronDown class="w-3 h-3" />
				</button>
				{#if showLayoutMenu}
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<div
						class="absolute right-0 top-full mt-1 bg-white dark:bg-zinc-800 rounded-lg shadow-lg border border-zinc-200 dark:border-zinc-700 py-1 z-20 min-w-[120px]"
						onmouseleave={() => showLayoutMenu = false}
					>
						<button
							class="w-full px-3 py-1.5 text-left text-xs flex items-center gap-2 hover:bg-zinc-100 dark:hover:bg-zinc-700 {currentLayout === 'breadthfirst' ? 'text-blue-600 dark:text-blue-400 font-medium' : 'text-zinc-700 dark:text-zinc-200'}"
							onclick={() => applyLayout('breadthfirst')}
						>
							<GitBranch class="w-3.5 h-3.5" />
							Tree
						</button>
						<button
							class="w-full px-3 py-1.5 text-left text-xs flex items-center gap-2 hover:bg-zinc-100 dark:hover:bg-zinc-700 {currentLayout === 'grid' ? 'text-blue-600 dark:text-blue-400 font-medium' : 'text-zinc-700 dark:text-zinc-200'}"
							onclick={() => applyLayout('grid')}
						>
							<LayoutGrid class="w-3.5 h-3.5" />
							Grid
						</button>
						<button
							class="w-full px-3 py-1.5 text-left text-xs flex items-center gap-2 hover:bg-zinc-100 dark:hover:bg-zinc-700 {currentLayout === 'circle' ? 'text-blue-600 dark:text-blue-400 font-medium' : 'text-zinc-700 dark:text-zinc-200'}"
							onclick={() => applyLayout('circle')}
						>
							<Circle class="w-3.5 h-3.5" />
							Circle
						</button>
						<button
							class="w-full px-3 py-1.5 text-left text-xs flex items-center gap-2 hover:bg-zinc-100 dark:hover:bg-zinc-700 {currentLayout === 'concentric' ? 'text-blue-600 dark:text-blue-400 font-medium' : 'text-zinc-700 dark:text-zinc-200'}"
							onclick={() => applyLayout('concentric')}
						>
							<Target class="w-3.5 h-3.5" />
							Radial
						</button>
						<button
							class="w-full px-3 py-1.5 text-left text-xs flex items-center gap-2 hover:bg-zinc-100 dark:hover:bg-zinc-700 {currentLayout === 'cose' ? 'text-blue-600 dark:text-blue-400 font-medium' : 'text-zinc-700 dark:text-zinc-200'}"
							onclick={() => applyLayout('cose')}
						>
							<Sparkles class="w-3.5 h-3.5" />
							Force
						</button>
					</div>
				{/if}
			</div>
			<div class="w-px h-4 bg-zinc-300 dark:bg-zinc-600 mx-1"></div>
			<!-- Theme toggle -->
			<button
				onclick={toggleGraphTheme}
				class="h-6 w-6 flex items-center justify-center rounded text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors"
				title={graphTheme === 'light' ? 'Switch to dark theme' : 'Switch to light theme'}
			>
				{#if graphTheme === 'light'}
					<Moon class="w-3.5 h-3.5" />
				{:else}
					<Sun class="w-3.5 h-3.5" />
				{/if}
			</button>
			<div class="w-px h-4 bg-zinc-300 dark:bg-zinc-600 mx-1"></div>
			<Button variant="ghost" size="sm" onclick={zoomOut} class="h-6 w-6 p-0 text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200">
				<ZoomOut class="w-3.5 h-3.5" />
			</Button>
			<Button variant="ghost" size="sm" onclick={zoomIn} class="h-6 w-6 p-0 text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200">
				<ZoomIn class="w-3.5 h-3.5" />
			</Button>
			<Button variant="ghost" size="sm" onclick={fitToScreen} class="h-6 w-6 p-0 text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200">
				<Maximize2 class="w-3.5 h-3.5" />
			</Button>
			<Button variant="ghost" size="sm" onclick={resetLayout} class="h-6 w-6 p-0 text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200">
				<RotateCcw class="w-3.5 h-3.5" />
			</Button>
		</div>
	</div>

	<div class="flex-1 flex min-h-0 h-full">
		<!-- Graph container -->
		<div class="flex-1 relative h-full {graphTheme === 'dark' ? 'bg-zinc-900' : 'bg-zinc-100'}">
			<div bind:this={containerEl} class="w-full h-full"></div>
			{#if parseError}
				<div class="absolute top-2 left-2 right-2 z-10">
					<div class="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-lg px-3 py-2 shadow-sm">
						<p class="text-xs text-red-600 dark:text-red-400 font-medium">YAML Parse Error</p>
						<p class="text-xs text-red-500 dark:text-red-300 mt-0.5 font-mono">{parseError}</p>
					</div>
				</div>
			{/if}
			<!-- Footer: Legend -->
			<div class="absolute bottom-2 left-2 pointer-events-none z-10">
				<div class="flex items-center gap-2 text-xs bg-white/80 dark:bg-zinc-800/80 backdrop-blur-sm rounded px-2 py-1 shadow-sm border border-zinc-200/50 dark:border-zinc-700/50 whitespace-nowrap">
					<div class="flex items-center gap-1 flex-shrink-0">
						<div class="w-2 h-2 rounded-sm bg-blue-500 flex-shrink-0"></div>
						<span class="text-zinc-600 dark:text-zinc-300">Service</span>
					</div>
					<div class="flex items-center gap-1 flex-shrink-0">
						<div class="w-2 h-2 rounded-sm bg-violet-500 flex-shrink-0"></div>
						<span class="text-zinc-600 dark:text-zinc-300">Network</span>
					</div>
					<div class="flex items-center gap-1 flex-shrink-0">
						<div class="w-2 h-2 rounded-sm bg-emerald-500 flex-shrink-0"></div>
						<span class="text-zinc-600 dark:text-zinc-300">Volume</span>
					</div>
					<div class="flex items-center gap-1 flex-shrink-0">
						<div class="w-2 h-2 rounded-sm bg-amber-500 flex-shrink-0"></div>
						<span class="text-zinc-600 dark:text-zinc-300">Config</span>
					</div>
					<div class="flex items-center gap-1 flex-shrink-0">
						<div class="w-2 h-2 rounded-sm bg-red-500 flex-shrink-0"></div>
						<span class="text-zinc-600 dark:text-zinc-300">Secret</span>
					</div>
				</div>
			</div>
			<!-- Details panel (overlay) -->
			{#if !readonly && (selectedNode || selectedEdge)}
				<div class="absolute top-0 right-0 bottom-0 w-[420px] border-l border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/95 shadow-lg z-20 flex flex-col">
				<!-- Sticky header -->
				{#if selectedNode}
					{@const NodeIcon = getNodeIcon(selectedNode.type)}
					<div class="sticky top-0 z-10 p-3 border-b border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/95">
						<div class="flex items-center justify-between">
							<div class="flex items-center gap-2">
								<div class="p-1.5 rounded {getNodeColor(selectedNode.type)}">
									<NodeIcon class="w-3.5 h-3.5 text-white" />
								</div>
								<div>
									<h3 class="font-semibold text-sm text-zinc-800 dark:text-zinc-100">{selectedNode.label}</h3>
									<p class="text-xs text-zinc-500 dark:text-zinc-400 capitalize">{selectedNode.type}</p>
								</div>
							</div>
							<div class="flex items-center gap-1">
								{#if (selectedNode.type === 'service' && serviceEditDirty) ||
									 (selectedNode.type === 'network' && networkEditDirty) ||
									 (selectedNode.type === 'volume' && volumeEditDirty) ||
									 (selectedNode.type === 'config' && configEditDirty) ||
									 (selectedNode.type === 'secret' && secretEditDirty)}
									<Button
										variant="ghost"
										size="sm"
										class="h-6 w-6 p-0 text-emerald-500 hover:text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-900/30"
										onclick={() => {
											if (selectedNode.type === 'service') saveServiceEdit();
											else if (selectedNode.type === 'network') saveNetworkEdit();
											else if (selectedNode.type === 'volume') saveVolumeEdit();
											else if (selectedNode.type === 'config') saveConfigEdit();
											else if (selectedNode.type === 'secret') saveSecretEdit();
											selectedNode = null;
											selectedEdge = null;
										}}
										title="Save and close"
									>
										<Save class="w-3.5 h-3.5" />
									</Button>
								{/if}
								<Button
									variant="ghost"
									size="sm"
									class="h-6 w-6 p-0 text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30"
									onclick={deleteSelectedNode}
									title="Delete"
								>
									<Trash2 class="w-3.5 h-3.5" />
								</Button>
								<Button
									variant="ghost"
									size="sm"
									class="h-6 w-6 p-0 text-zinc-500 hover:text-zinc-600 hover:bg-zinc-100 dark:hover:bg-zinc-700"
									onclick={() => { selectedNode = null; selectedEdge = null; }}
									title="Close"
								>
									<X class="w-3.5 h-3.5" />
								</Button>
							</div>
						</div>
					</div>
				{:else if selectedEdge}
					<!-- Sticky header for edge -->
					<div class="sticky top-0 z-10 p-3 border-b border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/95">
						<div class="flex items-center justify-between">
							<div>
								<h3 class="font-semibold text-sm text-zinc-800 dark:text-zinc-100 capitalize">{selectedEdge.type.replace('-', ' ')}</h3>
								<p class="text-xs text-zinc-500 dark:text-zinc-400">
									{selectedEdge.source.replace(/^(service|network|volume|config|secret)-/, '')}
									→
									{selectedEdge.target.replace(/^(service|network|volume|config|secret)-/, '')}
								</p>
							</div>
							<div class="flex items-center gap-1">
								<Button
									variant="ghost"
									size="sm"
									class="h-6 w-6 p-0 text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30"
									onclick={deleteSelectedEdge}
									title="Remove connection"
								>
									<Trash2 class="w-3.5 h-3.5" />
								</Button>
								<Button
									variant="ghost"
									size="sm"
									class="h-6 w-6 p-0 text-zinc-500 hover:text-zinc-600 hover:bg-zinc-100 dark:hover:bg-zinc-700"
									onclick={() => { selectedNode = null; selectedEdge = null; }}
									title="Close"
								>
									<X class="w-3.5 h-3.5" />
								</Button>
							</div>
						</div>
					</div>
				{/if}
				<!-- Scrollable content -->
				<div class="flex-1 overflow-y-auto p-3">
					{#if selectedNode}
						{#if selectedNode.type === 'service'}
							<div class="space-y-3 text-sm">
								<!-- Image -->
								<div class="space-y-1.5">
									<div class="flex items-center justify-between">
										<span class="text-xs font-medium text-zinc-600 dark:text-zinc-300">Image</span>
									</div>
									<Input
										bind:value={editServiceImage}
										oninput={markServiceDirty}
										placeholder="nginx:alpine"
										class="h-8 text-xs"
									/>
								</div>

								<!-- Command -->
								<div class="space-y-1.5">
									<span class="text-xs font-medium text-zinc-600 dark:text-zinc-300">Command</span>
									<Input
										bind:value={editServiceCommand}
										oninput={markServiceDirty}
										placeholder="/bin/sh -c '...'"
										class="h-8 text-xs"
									/>
								</div>

								<!-- Restart policy -->
								<div class="space-y-1.5">
									<span class="text-xs font-medium text-zinc-600 dark:text-zinc-300">Restart policy</span>
									<Select.Root type="single" bind:value={editServiceRestart} onValueChange={() => { serviceEditDirty = true; }}>
										<Select.Trigger class="h-8 text-xs">
											<span>{editServiceRestart === 'no' ? 'No' : editServiceRestart === 'always' ? 'Always' : editServiceRestart === 'on-failure' ? 'On failure' : 'Unless stopped'}</span>
										</Select.Trigger>
										<Select.Content>
											<Select.Item value="no" label="No" />
											<Select.Item value="always" label="Always" />
											<Select.Item value="on-failure" label="On failure" />
											<Select.Item value="unless-stopped" label="Unless stopped" />
										</Select.Content>
									</Select.Root>
								</div>

								<!-- Port mappings -->
								<div class="space-y-1.5">
									<div class="flex items-center justify-between">
										<span class="text-xs font-medium text-zinc-600 dark:text-zinc-300">Port mappings</span>
										<button onclick={addServicePort} class="text-xs text-blue-500 hover:text-blue-600">
											<Plus class="w-3.5 h-3.5" />
										</button>
									</div>
									<div class="space-y-4 pt-2">
										{#each editServicePorts as port, index}
											<div class="flex gap-1 items-center">
												<div class="flex-1 relative">
													<span class="absolute -top-2 left-2 text-[9px] text-zinc-400 bg-white dark:bg-zinc-800 px-1 z-10">Host</span>
													<Input bind:value={port.host} oninput={markServiceDirty} class="h-9 pt-3 text-xs" />
												</div>
												<div class="flex-1 relative">
													<span class="absolute -top-2 left-2 text-[9px] text-zinc-400 bg-white dark:bg-zinc-800 px-1 z-10">Container</span>
													<Input bind:value={port.container} oninput={markServiceDirty} class="h-9 pt-3 text-xs" />
												</div>
												<button
													onclick={() => removeServicePort(index)}
													disabled={editServicePorts.length === 1}
													class="p-1 text-zinc-400 hover:text-red-500 disabled:opacity-30"
												>
													<Trash2 class="w-3 h-3" />
												</button>
											</div>
										{/each}
									</div>
								</div>

								<!-- Volumes -->
								<div class="space-y-1.5">
									<div class="flex items-center justify-between">
										<span class="text-xs font-medium text-zinc-600 dark:text-zinc-300">Volumes</span>
										<button onclick={addServiceVolume} class="text-xs text-blue-500 hover:text-blue-600">
											<Plus class="w-3.5 h-3.5" />
										</button>
									</div>
									<div class="space-y-4 pt-2">
										{#each editServiceVolumes as vol, index}
											<div class="flex gap-1 items-center">
												<div class="flex-1 relative">
													<span class="absolute -top-2 left-2 text-[9px] text-zinc-400 bg-white dark:bg-zinc-800 px-1 z-10">Host</span>
													<Input bind:value={vol.host} oninput={markServiceDirty} class="h-9 pt-3 text-xs" />
												</div>
												<div class="flex-1 relative">
													<span class="absolute -top-2 left-2 text-[9px] text-zinc-400 bg-white dark:bg-zinc-800 px-1 z-10">Container</span>
													<Input bind:value={vol.container} oninput={markServiceDirty} class="h-9 pt-3 text-xs" />
												</div>
												<button
													onclick={() => removeServiceVolume(index)}
													disabled={editServiceVolumes.length === 1}
													class="p-1 text-zinc-400 hover:text-red-500 disabled:opacity-30"
												>
													<Trash2 class="w-3 h-3" />
												</button>
											</div>
										{/each}
									</div>
								</div>

								<!-- Environment variables -->
								<div class="space-y-1.5">
									<div class="flex items-center justify-between">
										<span class="text-xs font-medium text-zinc-600 dark:text-zinc-300">Environment</span>
										<button onclick={addServiceEnvVar} class="text-xs text-blue-500 hover:text-blue-600">
											<Plus class="w-3.5 h-3.5" />
										</button>
									</div>
									<div class="space-y-4 pt-2">
										{#each editServiceEnvVars as env, index}
											<div class="flex gap-1 items-center">
												<div class="flex-1 relative">
													<span class="absolute -top-2 left-2 text-[9px] text-zinc-400 bg-white dark:bg-zinc-800 px-1 z-10">Key</span>
													<Input bind:value={env.key} oninput={markServiceDirty} class="h-9 pt-3 text-xs" />
												</div>
												<div class="flex-1 relative">
													<span class="absolute -top-2 left-2 text-[9px] text-zinc-400 bg-white dark:bg-zinc-800 px-1 z-10">Value</span>
													<Input bind:value={env.value} oninput={markServiceDirty} class="h-9 pt-3 text-xs" />
												</div>
												<button
													onclick={() => removeServiceEnvVar(index)}
													disabled={editServiceEnvVars.length === 1}
													class="p-1 text-zinc-400 hover:text-red-500 disabled:opacity-30"
												>
													<Trash2 class="w-3 h-3" />
												</button>
											</div>
										{/each}
									</div>
								</div>

								<!-- Labels -->
								<div class="space-y-1.5">
									<div class="flex items-center justify-between">
										<span class="text-xs font-medium text-zinc-600 dark:text-zinc-300">Labels</span>
										<button onclick={addServiceLabel} class="text-xs text-blue-500 hover:text-blue-600">
											<Plus class="w-3.5 h-3.5" />
										</button>
									</div>
									<div class="space-y-4 pt-2">
										{#each editServiceLabels as label, index}
											<div class="flex gap-1 items-center">
												<div class="flex-1 relative">
													<span class="absolute -top-2 left-2 text-[9px] text-zinc-400 bg-white dark:bg-zinc-800 px-1 z-10">Key</span>
													<Input bind:value={label.key} oninput={markServiceDirty} class="h-9 pt-3 text-xs" />
												</div>
												<div class="flex-1 relative">
													<span class="absolute -top-2 left-2 text-[9px] text-zinc-400 bg-white dark:bg-zinc-800 px-1 z-10">Value</span>
													<Input bind:value={label.value} oninput={markServiceDirty} class="h-9 pt-3 text-xs" />
												</div>
												<button
													onclick={() => removeServiceLabel(index)}
													disabled={editServiceLabels.length === 1}
													class="p-1 text-zinc-400 hover:text-red-500 disabled:opacity-30"
												>
													<Trash2 class="w-3 h-3" />
												</button>
											</div>
										{/each}
									</div>
								</div>

								<!-- Dependencies -->
								{#if selectedNode.dependsOn?.length > 0}
									<div class="space-y-1.5">
										<span class="text-xs font-medium text-zinc-600 dark:text-zinc-300">Depends on</span>
										<div class="space-y-1">
											{#each selectedNode.dependsOn as dep}
												<div class="flex items-center justify-between text-zinc-700 text-xs bg-zinc-100 px-2 py-1.5 rounded">
													<span class="font-mono">{dep}</span>
													<button
														class="text-zinc-400 hover:text-red-500"
														onclick={() => removeDependency(dep, selectedNode.label)}
														title="Remove dependency"
													>
														<X class="w-3 h-3" />
													</button>
												</div>
											{/each}
										</div>
									</div>
								{/if}
							</div>
						{:else if selectedNode.type === 'network'}
							<div class="space-y-3 text-sm">
								<!-- Driver -->
								<div class="space-y-1.5">
									<span class="text-xs font-medium text-zinc-600 dark:text-zinc-300">Driver</span>
									<Select.Root type="single" bind:value={editNetworkDriver} onValueChange={() => { networkEditDirty = true; }}>
										<Select.Trigger class="h-8 text-xs">
											<span class="flex items-center gap-1.5">
												{#if editNetworkDriver === 'bridge'}
													<Share2 class="w-3.5 h-3.5 text-emerald-500" />
												{:else if editNetworkDriver === 'host'}
													<Server class="w-3.5 h-3.5 text-sky-500" />
												{:else if editNetworkDriver === 'overlay'}
													<Globe class="w-3.5 h-3.5 text-violet-500" />
												{:else if editNetworkDriver === 'macvlan'}
													<MonitorSmartphone class="w-3.5 h-3.5 text-amber-500" />
												{:else if editNetworkDriver === 'ipvlan'}
													<Cpu class="w-3.5 h-3.5 text-orange-500" />
												{:else}
													<CircleOff class="w-3.5 h-3.5 text-muted-foreground" />
												{/if}
												<span class="capitalize">{editNetworkDriver}</span>
											</span>
										</Select.Trigger>
										<Select.Content>
											<Select.Item value="bridge" label="Bridge">
												{#snippet children()}
													<div class="flex items-center gap-2">
														<Share2 class="w-3.5 h-3.5 text-emerald-500" />
														<span>Bridge</span>
													</div>
												{/snippet}
											</Select.Item>
											<Select.Item value="host" label="Host">
												{#snippet children()}
													<div class="flex items-center gap-2">
														<Server class="w-3.5 h-3.5 text-sky-500" />
														<span>Host</span>
													</div>
												{/snippet}
											</Select.Item>
											<Select.Item value="overlay" label="Overlay">
												{#snippet children()}
													<div class="flex items-center gap-2">
														<Globe class="w-3.5 h-3.5 text-violet-500" />
														<span>Overlay</span>
													</div>
												{/snippet}
											</Select.Item>
											<Select.Item value="macvlan" label="Macvlan">
												{#snippet children()}
													<div class="flex items-center gap-2">
														<MonitorSmartphone class="w-3.5 h-3.5 text-amber-500" />
														<span>Macvlan</span>
													</div>
												{/snippet}
											</Select.Item>
											<Select.Item value="ipvlan" label="IPvlan">
												{#snippet children()}
													<div class="flex items-center gap-2">
														<Cpu class="w-3.5 h-3.5 text-orange-500" />
														<span>IPvlan</span>
													</div>
												{/snippet}
											</Select.Item>
											<Select.Item value="none" label="None">
												{#snippet children()}
													<div class="flex items-center gap-2">
														<CircleOff class="w-3.5 h-3.5 text-muted-foreground" />
														<span>None</span>
													</div>
												{/snippet}
											</Select.Item>
										</Select.Content>
									</Select.Root>
								</div>

								<!-- IPAM Config -->
								<div class="space-y-1.5">
									<span class="text-xs font-medium text-zinc-600 dark:text-zinc-300">IPAM configuration</span>
									<div class="space-y-4 pt-2">
										<div class="relative">
											<span class="absolute -top-2 left-2 text-[9px] text-zinc-400 bg-white dark:bg-zinc-800 px-1 z-10">Subnet</span>
											<Input bind:value={editNetworkSubnet} oninput={markNetworkDirty} placeholder="172.20.0.0/16" class="h-9 pt-3 text-xs" />
										</div>
										<div class="relative">
											<span class="absolute -top-2 left-2 text-[9px] text-zinc-400 bg-white dark:bg-zinc-800 px-1 z-10">Gateway</span>
											<Input bind:value={editNetworkGateway} oninput={markNetworkDirty} placeholder="172.20.0.1" class="h-9 pt-3 text-xs" />
										</div>
									</div>
								</div>

								<!-- Boolean flags -->
								<div class="space-y-2">
									<label class="flex items-center gap-2 cursor-pointer">
										<input type="checkbox" bind:checked={editNetworkExternal} onchange={markNetworkDirty} class="rounded border-zinc-300" />
										<span class="text-xs text-zinc-600">External network</span>
									</label>
									<label class="flex items-center gap-2 cursor-pointer">
										<input type="checkbox" bind:checked={editNetworkInternal} onchange={markNetworkDirty} class="rounded border-zinc-300" />
										<span class="text-xs text-zinc-600">Internal network</span>
									</label>
									<label class="flex items-center gap-2 cursor-pointer">
										<input type="checkbox" bind:checked={editNetworkAttachable} onchange={markNetworkDirty} class="rounded border-zinc-300" />
										<span class="text-xs text-zinc-600">Attachable</span>
									</label>
								</div>

								<!-- Labels -->
								<div class="space-y-1.5">
									<div class="flex items-center justify-between">
										<span class="text-xs font-medium text-zinc-600 dark:text-zinc-300">Labels</span>
										<button onclick={addNetworkLabel} class="text-xs text-blue-500 hover:text-blue-600">
											<Plus class="w-3.5 h-3.5" />
										</button>
									</div>
									<div class="space-y-4 pt-2">
										{#each editNetworkLabels as label, index}
											<div class="flex gap-1 items-center">
												<div class="flex-1 relative">
													<span class="absolute -top-2 left-2 text-[9px] text-zinc-400 bg-white dark:bg-zinc-800 px-1 z-10">Key</span>
													<Input bind:value={label.key} oninput={markNetworkDirty} class="h-9 pt-3 text-xs" />
												</div>
												<div class="flex-1 relative">
													<span class="absolute -top-2 left-2 text-[9px] text-zinc-400 bg-white dark:bg-zinc-800 px-1 z-10">Value</span>
													<Input bind:value={label.value} oninput={markNetworkDirty} class="h-9 pt-3 text-xs" />
												</div>
												<button onclick={() => removeNetworkLabel(index)} disabled={editNetworkLabels.length === 1} class="p-1 text-zinc-400 hover:text-red-500 disabled:opacity-30">
													<Trash2 class="w-3 h-3" />
												</button>
											</div>
										{/each}
									</div>
								</div>

								<!-- Driver options -->
								<div class="space-y-1.5">
									<div class="flex items-center justify-between">
										<span class="text-xs font-medium text-zinc-600 dark:text-zinc-300">Driver options</span>
										<button onclick={addNetworkOption} class="text-xs text-blue-500 hover:text-blue-600">
											<Plus class="w-3.5 h-3.5" />
										</button>
									</div>
									<div class="space-y-4 pt-2">
										{#each editNetworkOptions as opt, index}
											<div class="flex gap-1 items-center">
												<div class="flex-1 relative">
													<span class="absolute -top-2 left-2 text-[9px] text-zinc-400 bg-white dark:bg-zinc-800 px-1 z-10">Key</span>
													<Input bind:value={opt.key} oninput={markNetworkDirty} class="h-9 pt-3 text-xs" />
												</div>
												<div class="flex-1 relative">
													<span class="absolute -top-2 left-2 text-[9px] text-zinc-400 bg-white dark:bg-zinc-800 px-1 z-10">Value</span>
													<Input bind:value={opt.value} oninput={markNetworkDirty} class="h-9 pt-3 text-xs" />
												</div>
												<button onclick={() => removeNetworkOption(index)} disabled={editNetworkOptions.length === 1} class="p-1 text-zinc-400 hover:text-red-500 disabled:opacity-30">
													<Trash2 class="w-3 h-3" />
												</button>
											</div>
										{/each}
									</div>
								</div>
							</div>

						{:else if selectedNode.type === 'volume'}
							<div class="space-y-3 text-sm">
								<!-- Driver -->
								<div class="space-y-1.5">
									<span class="text-xs font-medium text-zinc-600 dark:text-zinc-300">Driver</span>
									<Input bind:value={editVolumeDriver} oninput={markVolumeDirty} placeholder="local" class="h-8 text-xs" />
								</div>

								<!-- External -->
								<label class="flex items-center gap-2 cursor-pointer">
									<input type="checkbox" bind:checked={editVolumeExternal} onchange={markVolumeDirty} class="rounded border-zinc-300" />
									<span class="text-xs text-zinc-600">External volume</span>
								</label>

								<!-- Labels -->
								<div class="space-y-1.5">
									<div class="flex items-center justify-between">
										<span class="text-xs font-medium text-zinc-600 dark:text-zinc-300">Labels</span>
										<button onclick={addVolumeLabel} class="text-xs text-blue-500 hover:text-blue-600">
											<Plus class="w-3.5 h-3.5" />
										</button>
									</div>
									<div class="space-y-4 pt-2">
										{#each editVolumeLabels as label, index}
											<div class="flex gap-1 items-center">
												<div class="flex-1 relative">
													<span class="absolute -top-2 left-2 text-[9px] text-zinc-400 bg-white dark:bg-zinc-800 px-1 z-10">Key</span>
													<Input bind:value={label.key} oninput={markVolumeDirty} class="h-9 pt-3 text-xs" />
												</div>
												<div class="flex-1 relative">
													<span class="absolute -top-2 left-2 text-[9px] text-zinc-400 bg-white dark:bg-zinc-800 px-1 z-10">Value</span>
													<Input bind:value={label.value} oninput={markVolumeDirty} class="h-9 pt-3 text-xs" />
												</div>
												<button onclick={() => removeVolumeLabel(index)} disabled={editVolumeLabels.length === 1} class="p-1 text-zinc-400 hover:text-red-500 disabled:opacity-30">
													<Trash2 class="w-3 h-3" />
												</button>
											</div>
										{/each}
									</div>
								</div>

								<!-- Driver options -->
								<div class="space-y-1.5">
									<div class="flex items-center justify-between">
										<span class="text-xs font-medium text-zinc-600 dark:text-zinc-300">Driver options</span>
										<button onclick={addVolumeOption} class="text-xs text-blue-500 hover:text-blue-600">
											<Plus class="w-3.5 h-3.5" />
										</button>
									</div>
									<div class="space-y-4 pt-2">
										{#each editVolumeOptions as opt, index}
											<div class="flex gap-1 items-center">
												<div class="flex-1 relative">
													<span class="absolute -top-2 left-2 text-[9px] text-zinc-400 bg-white dark:bg-zinc-800 px-1 z-10">Key</span>
													<Input bind:value={opt.key} oninput={markVolumeDirty} class="h-9 pt-3 text-xs" />
												</div>
												<div class="flex-1 relative">
													<span class="absolute -top-2 left-2 text-[9px] text-zinc-400 bg-white dark:bg-zinc-800 px-1 z-10">Value</span>
													<Input bind:value={opt.value} oninput={markVolumeDirty} class="h-9 pt-3 text-xs" />
												</div>
												<button onclick={() => removeVolumeOption(index)} disabled={editVolumeOptions.length === 1} class="p-1 text-zinc-400 hover:text-red-500 disabled:opacity-30">
													<Trash2 class="w-3 h-3" />
												</button>
											</div>
										{/each}
									</div>
								</div>
							</div>

						{:else if selectedNode.type === 'config'}
							<div class="space-y-3 text-sm">
								<!-- External checkbox -->
								<label class="flex items-center gap-2 cursor-pointer">
									<input type="checkbox" bind:checked={editConfigExternal} onchange={markConfigDirty} class="rounded border-zinc-300" />
									<span class="text-xs text-zinc-600">External config</span>
								</label>

								{#if editConfigExternal}
									<!-- External name -->
									<div class="space-y-1.5">
										<span class="text-xs font-medium text-zinc-600 dark:text-zinc-300">External name (optional)</span>
										<Input bind:value={editConfigName} oninput={markConfigDirty} placeholder="my-external-config" class="h-8 text-xs" />
									</div>
								{:else}
									<!-- Source type selector hint -->
									<p class="text-2xs text-zinc-400">Specify one of: file, content, or environment</p>

									<!-- File path -->
									<div class="space-y-1.5">
										<span class="text-xs font-medium text-zinc-600 dark:text-zinc-300">File path</span>
										<Input bind:value={editConfigFile} oninput={markConfigDirty} placeholder="./config/app.conf" class="h-8 text-xs" />
									</div>

									<!-- Content -->
									<div class="space-y-1.5">
										<span class="text-xs font-medium text-zinc-600 dark:text-zinc-300">Content (inline)</span>
										<textarea
											bind:value={editConfigContent}
											oninput={markConfigDirty}
											placeholder="key=value&#10;another=setting"
											class="w-full h-20 text-xs rounded-md border border-zinc-200 px-2 py-1.5 resize-none focus:outline-none focus:ring-1 focus:ring-zinc-400"
										></textarea>
									</div>

									<!-- Environment variable -->
									<div class="space-y-1.5">
										<span class="text-xs font-medium text-zinc-600 dark:text-zinc-300">Environment variable</span>
										<Input bind:value={editConfigEnvironment} oninput={markConfigDirty} placeholder="MY_CONFIG_VAR" class="h-8 text-xs" />
									</div>
								{/if}
							</div>

						{:else if selectedNode.type === 'secret'}
							<div class="space-y-3 text-sm">
								<!-- External checkbox -->
								<label class="flex items-center gap-2 cursor-pointer">
									<input type="checkbox" bind:checked={editSecretExternal} onchange={markSecretDirty} class="rounded border-zinc-300" />
									<span class="text-xs text-zinc-600">External secret</span>
								</label>

								{#if editSecretExternal}
									<!-- External name -->
									<div class="space-y-1.5">
										<span class="text-xs font-medium text-zinc-600 dark:text-zinc-300">External name (optional)</span>
										<Input bind:value={editSecretName} oninput={markSecretDirty} placeholder="my-external-secret" class="h-8 text-xs" />
									</div>
								{:else}
									<!-- Source type selector hint -->
									<p class="text-2xs text-zinc-400">Specify one of: file or environment</p>

									<!-- File path -->
									<div class="space-y-1.5">
										<span class="text-xs font-medium text-zinc-600 dark:text-zinc-300">File path</span>
										<Input bind:value={editSecretFile} oninput={markSecretDirty} placeholder="./secrets/password.txt" class="h-8 text-xs" />
									</div>

									<!-- Environment variable -->
									<div class="space-y-1.5">
										<span class="text-xs font-medium text-zinc-600 dark:text-zinc-300">Environment variable</span>
										<Input bind:value={editSecretEnvironment} oninput={markSecretDirty} placeholder="MY_SECRET_VAR" class="h-8 text-xs" />
									</div>
								{/if}
							</div>
						{/if}
					{:else if selectedEdge}
						{#if selectedEdge.type === 'dependency'}
							<p class="text-xs text-zinc-500 dark:text-zinc-400">
								This service depends on {selectedEdge.source.replace('service-', '')} and will start after it.
							</p>
						{:else if selectedEdge.type === 'volume-mount'}
							<p class="text-xs text-zinc-500 dark:text-zinc-400">
								Volume mounted to this service.
							</p>
						{:else if selectedEdge.type === 'network-connection'}
							<p class="text-xs text-zinc-500 dark:text-zinc-400">
								Service connected to this network.
							</p>
						{:else if selectedEdge.type === 'config-mount'}
							<p class="text-xs text-zinc-500 dark:text-zinc-400">
								Config mounted to this service.
							</p>
						{:else if selectedEdge.type === 'secret-mount'}
							<p class="text-xs text-zinc-500 dark:text-zinc-400">
								Secret mounted to this service.
							</p>
						{/if}
					{/if}
				</div>
				</div>
			{/if}
		</div>
	</div>
</div>

<!-- Add Element Dialog -->
<Dialog.Root bind:open={showAddDialog}>
	<Dialog.Content class="max-w-md">
		<Dialog.Header>
			<Dialog.Title class="flex items-center gap-2">
				{@const DialogIcon = getNodeIcon(addElementType)}
				<DialogIcon class="w-5 h-5" />
				Add {getElementTypeLabel(addElementType)}
			</Dialog.Title>
		</Dialog.Header>

		<div class="space-y-4 py-4">
			<div class="space-y-2">
				<Label for="element-name">Name</Label>
				<Input
					id="element-name"
					bind:value={newElementName}
					placeholder={`my-${addElementType}`}
				/>
			</div>

			{#if addElementType === 'service'}
				<div class="space-y-2">
					<Label for="service-image">Image</Label>
					<Input
						id="service-image"
						bind:value={newServiceImage}
						placeholder="nginx:alpine"
					/>
				</div>

				<div class="space-y-2">
					<Label for="service-ports">Ports (comma-separated)</Label>
					<Input
						id="service-ports"
						bind:value={newServicePorts}
						placeholder="8080:80, 443:443"
					/>
				</div>
			{/if}
		</div>

		<div class="flex justify-end gap-2">
			<Button variant="outline" size="sm" onclick={() => showAddDialog = false}>Cancel</Button>
			<Button variant="secondary" size="sm" onclick={addElement} disabled={!newElementName.trim()}>
				<Plus class="w-3.5 h-3.5 mr-1.5" />
				Add {getElementTypeLabel(addElementType)}
			</Button>
		</div>
	</Dialog.Content>
</Dialog.Root>

<!-- Click outside to close add menu -->
{#if showAddMenu}
	<button
		class="fixed inset-0 z-40"
		onclick={() => showAddMenu = false}
		aria-label="Close menu"
	></button>
{/if}
