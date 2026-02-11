/**
 * Subprocess Manager
 *
 * Manages background subprocesses for metrics and event collection using Bun.spawn.
 * Provides crash recovery, graceful shutdown, and IPC message routing.
 */

import { Subprocess } from 'bun';
import { saveHostMetric, logContainerEvent, type ContainerEventAction } from './db';
import { sendEventNotification, sendEnvironmentNotification } from './notifications';
import { containerEventEmitter } from './event-collector';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

// Get the directory of this file (works in both Vite and Bun)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Determine subprocess script paths
// In development: src/lib/server/subprocesses/*.ts (via __dirname)
// In production: /app/subprocesses/*.js (bundled by scripts/build-subprocesses.ts)
function getSubprocessPath(name: string): string {
	// Production path (Docker container) - bundled JS files
	const prodPath = `/app/subprocesses/${name}.js`;
	if (existsSync(prodPath)) {
		return prodPath;
	}
	// Development path (relative to this file) - raw TS files
	return path.join(__dirname, 'subprocesses', `${name}.ts`);
}

// IPC Message Types (Subprocess → Main)
export interface MetricMessage {
	type: 'metric';
	envId: number;
	cpu: number;
	memPercent: number;
	memUsed: number;
	memTotal: number;
}

export interface DiskWarningMessage {
	type: 'disk_warning';
	envId: number;
	envName: string;
	message: string;
	diskPercent?: number;
}

export interface ContainerEventMessage {
	type: 'container_event';
	event: {
		environmentId: number;
		containerId: string;
		containerName: string | null;
		image: string | null;
		action: ContainerEventAction;
		actorAttributes: Record<string, string> | null;
		timestamp: string;
	};
	notification?: {
		action: ContainerEventAction;
		title: string;
		message: string;
		notificationType: 'success' | 'error' | 'warning' | 'info';
		image?: string;
	};
}

export interface EnvStatusMessage {
	type: 'env_status';
	envId: number;
	envName: string;
	online: boolean;
	error?: string;
}

export interface ReadyMessage {
	type: 'ready';
}

export interface ErrorMessage {
	type: 'error';
	message: string;
}

export type SubprocessMessage =
	| MetricMessage
	| DiskWarningMessage
	| ContainerEventMessage
	| EnvStatusMessage
	| ReadyMessage
	| ErrorMessage;

// IPC Message Types (Main → Subprocess)
export interface RefreshEnvironmentsCommand {
	type: 'refresh_environments';
}

export interface ShutdownCommand {
	type: 'shutdown';
}

export interface UpdateIntervalCommand {
	type: 'update_interval';
	intervalMs: number;
}

export type MainProcessCommand = RefreshEnvironmentsCommand | ShutdownCommand | UpdateIntervalCommand;

// Subprocess configuration
interface SubprocessConfig {
	name: string;
	scriptPath: string;
	restartDelayMs: number;
	maxRestarts: number;
}

// Subprocess state
interface SubprocessState {
	process: Subprocess<'ignore', 'inherit', 'inherit'> | null;
	restartCount: number;
	lastRestartTime: number;
	isShuttingDown: boolean;
}

class SubprocessManager {
	private metricsState: SubprocessState = {
		process: null,
		restartCount: 0,
		lastRestartTime: 0,
		isShuttingDown: false
	};

	private eventsState: SubprocessState = {
		process: null,
		restartCount: 0,
		lastRestartTime: 0,
		isShuttingDown: false
	};

	private readonly metricsConfig: SubprocessConfig = {
		name: 'metrics-subprocess',
		scriptPath: getSubprocessPath('metrics-subprocess'),
		restartDelayMs: 5000,
		maxRestarts: 10
	};

	private readonly eventsConfig: SubprocessConfig = {
		name: 'event-subprocess',
		scriptPath: getSubprocessPath('event-subprocess'),
		restartDelayMs: 5000,
		maxRestarts: 10
	};

	/**
	 * Start all subprocesses
	 */
	async start(): Promise<void> {
		console.log('[SubprocessManager] Starting background subprocesses...');

		await this.startMetricsSubprocess();
		await this.startEventsSubprocess();

		console.log('[SubprocessManager] All subprocesses started');
	}

	/**
	 * Stop all subprocesses gracefully
	 */
	async stop(): Promise<void> {
		console.log('[SubprocessManager] Stopping background subprocesses...');

		this.metricsState.isShuttingDown = true;
		this.eventsState.isShuttingDown = true;

		// Send shutdown commands
		this.sendToMetrics({ type: 'shutdown' });
		this.sendToEvents({ type: 'shutdown' });

		// Wait a bit for graceful shutdown
		await new Promise((resolve) => setTimeout(resolve, 1000));

		// Force kill if still running
		if (this.metricsState.process) {
			this.metricsState.process.kill();
			this.metricsState.process = null;
		}
		if (this.eventsState.process) {
			this.eventsState.process.kill();
			this.eventsState.process = null;
		}

		console.log('[SubprocessManager] All subprocesses stopped');
	}

	/**
	 * Notify subprocesses to refresh their environment list
	 */
	refreshEnvironments(): void {
		this.sendToMetrics({ type: 'refresh_environments' });
		this.sendToEvents({ type: 'refresh_environments' });
	}

	/**
	 * Send message to metrics subprocess
	 */
	sendToMetricsSubprocess(message: MainProcessCommand): void {
		this.sendToMetrics(message);
	}

	/**
	 * Send message to events subprocess
	 */
	sendToEventsSubprocess(message: MainProcessCommand): void {
		this.sendToEvents(message);
	}

	/**
	 * Start the metrics collection subprocess
	 */
	private async startMetricsSubprocess(): Promise<void> {
		if (this.metricsState.isShuttingDown) return;

		try {
			console.log(`[SubprocessManager] Starting ${this.metricsConfig.name}...`);

			const proc = Bun.spawn(['bun', 'run', this.metricsConfig.scriptPath], {
				stdio: ['inherit', 'inherit', 'inherit'],
				env: { ...process.env, SKIP_MIGRATIONS: '1' },
				ipc: (message) => this.handleMetricsMessage(message as SubprocessMessage),
				onExit: (proc, exitCode, signalCode) => {
					this.handleMetricsExit(exitCode, signalCode);
				}
			});

			this.metricsState.process = proc;
			this.metricsState.restartCount = 0;

			console.log(`[SubprocessManager] ${this.metricsConfig.name} started (PID: ${proc.pid})`);
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			console.error(`[SubprocessManager] Failed to start ${this.metricsConfig.name}: ${msg}`);
			this.scheduleMetricsRestart();
		}
	}

	/**
	 * Start the event collection subprocess
	 */
	private async startEventsSubprocess(): Promise<void> {
		if (this.eventsState.isShuttingDown) return;

		try {
			console.log(`[SubprocessManager] Starting ${this.eventsConfig.name}...`);

			const proc = Bun.spawn(['bun', 'run', this.eventsConfig.scriptPath], {
				stdio: ['inherit', 'inherit', 'inherit'],
				env: { ...process.env, SKIP_MIGRATIONS: '1' },
				ipc: (message) => this.handleEventsMessage(message as SubprocessMessage),
				onExit: (proc, exitCode, signalCode) => {
					this.handleEventsExit(exitCode, signalCode);
				}
			});

			this.eventsState.process = proc;
			this.eventsState.restartCount = 0;

			console.log(`[SubprocessManager] ${this.eventsConfig.name} started (PID: ${proc.pid})`);
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			console.error(`[SubprocessManager] Failed to start ${this.eventsConfig.name}: ${msg}`);
			this.scheduleEventsRestart();
		}
	}

	/**
	 * Handle IPC messages from metrics subprocess
	 */
	private async handleMetricsMessage(message: SubprocessMessage): Promise<void> {
		try {
			switch (message.type) {
				case 'ready':
					console.log(`[SubprocessManager] ${this.metricsConfig.name} is ready`);
					break;

				case 'metric':
					// Save metric to database
					await saveHostMetric(
						message.cpu,
						message.memPercent,
						message.memUsed,
						message.memTotal,
						message.envId
					);
					break;

				case 'disk_warning':
					// Send disk warning notification
					await sendEventNotification(
						'disk_space_warning',
						{
							title: message.diskPercent ? 'Disk space warning' : 'High Docker disk usage',
							message: message.message,
							type: 'warning'
						},
						message.envId
					);
					break;

				case 'error':
					console.error(`[SubprocessManager] ${this.metricsConfig.name} error:`, message.message);
					break;
			}
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			console.error(`[SubprocessManager] Error handling metrics message: ${msg}`);
		}
	}

	/**
	 * Handle IPC messages from events subprocess
	 */
	private async handleEventsMessage(message: SubprocessMessage): Promise<void> {
		try {
			switch (message.type) {
				case 'ready':
					console.log(`[SubprocessManager] ${this.eventsConfig.name} is ready`);
					break;

				case 'container_event':
					// Save event to database
					const savedEvent = await logContainerEvent(message.event);

					// Broadcast to SSE clients
					containerEventEmitter.emit('event', savedEvent);

					// Send notification if provided
					if (message.notification) {
						const { action, title, message: notifMessage, notificationType, image } = message.notification;
						sendEnvironmentNotification(message.event.environmentId, action, {
							title,
							message: notifMessage,
							type: notificationType
						}, image).catch((err) => {
							const errorMsg = err instanceof Error ? err.message : String(err);
							console.error('[SubprocessManager] Failed to send notification:', errorMsg);
						});
					}
					break;

				case 'env_status':
					// Broadcast to dashboard via containerEventEmitter
					containerEventEmitter.emit('env_status', {
						envId: message.envId,
						envName: message.envName,
						online: message.online,
						error: message.error
					});

					// Send environment status notification
					if (message.online) {
						await sendEventNotification(
							'environment_online',
							{
								title: 'Environment online',
								message: `Environment "${message.envName}" is now reachable`,
								type: 'success'
							},
							message.envId
						).catch((err) => {
							const errorMsg = err instanceof Error ? err.message : String(err);
							console.error('[SubprocessManager] Failed to send online notification:', errorMsg);
						});
					} else {
						await sendEventNotification(
							'environment_offline',
							{
								title: 'Environment offline',
								message: `Environment "${message.envName}" is unreachable${message.error ? `: ${message.error}` : ''}`,
								type: 'error'
							},
							message.envId
						).catch((err) => {
							const errorMsg = err instanceof Error ? err.message : String(err);
							console.error('[SubprocessManager] Failed to send offline notification:', errorMsg);
						});
					}
					break;

				case 'error':
					console.error(`[SubprocessManager] ${this.eventsConfig.name} error:`, message.message);
					break;
			}
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			console.error(`[SubprocessManager] Error handling events message: ${msg}`);
		}
	}

	/**
	 * Handle metrics subprocess exit
	 */
	private handleMetricsExit(exitCode: number | null, signalCode: string | null): void {
		if (this.metricsState.isShuttingDown) {
			console.log(`[SubprocessManager] ${this.metricsConfig.name} stopped`);
			return;
		}

		console.error(
			`[SubprocessManager] ${this.metricsConfig.name} exited unexpectedly (code: ${exitCode}, signal: ${signalCode})`
		);

		this.metricsState.process = null;
		this.scheduleMetricsRestart();
	}

	/**
	 * Handle events subprocess exit
	 */
	private handleEventsExit(exitCode: number | null, signalCode: string | null): void {
		if (this.eventsState.isShuttingDown) {
			console.log(`[SubprocessManager] ${this.eventsConfig.name} stopped`);
			return;
		}

		console.error(
			`[SubprocessManager] ${this.eventsConfig.name} exited unexpectedly (code: ${exitCode}, signal: ${signalCode})`
		);

		this.eventsState.process = null;
		this.scheduleEventsRestart();
	}

	/**
	 * Schedule metrics subprocess restart with backoff
	 */
	private scheduleMetricsRestart(): void {
		if (this.metricsState.isShuttingDown) return;

		if (this.metricsState.restartCount >= this.metricsConfig.maxRestarts) {
			console.error(
				`[SubprocessManager] ${this.metricsConfig.name} exceeded max restarts (${this.metricsConfig.maxRestarts}), giving up`
			);
			return;
		}

		const delay = this.metricsConfig.restartDelayMs * Math.pow(2, this.metricsState.restartCount);
		this.metricsState.restartCount++;

		console.log(
			`[SubprocessManager] Restarting ${this.metricsConfig.name} in ${delay}ms (attempt ${this.metricsState.restartCount}/${this.metricsConfig.maxRestarts})`
		);

		setTimeout(() => {
			this.startMetricsSubprocess();
		}, delay);
	}

	/**
	 * Schedule events subprocess restart with backoff
	 */
	private scheduleEventsRestart(): void {
		if (this.eventsState.isShuttingDown) return;

		if (this.eventsState.restartCount >= this.eventsConfig.maxRestarts) {
			console.error(
				`[SubprocessManager] ${this.eventsConfig.name} exceeded max restarts (${this.eventsConfig.maxRestarts}), giving up`
			);
			return;
		}

		const delay = this.eventsConfig.restartDelayMs * Math.pow(2, this.eventsState.restartCount);
		this.eventsState.restartCount++;

		console.log(
			`[SubprocessManager] Restarting ${this.eventsConfig.name} in ${delay}ms (attempt ${this.eventsState.restartCount}/${this.eventsConfig.maxRestarts})`
		);

		setTimeout(() => {
			this.startEventsSubprocess();
		}, delay);
	}

	/**
	 * Send command to metrics subprocess
	 */
	private sendToMetrics(command: MainProcessCommand): void {
		if (this.metricsState.process) {
			try {
				this.metricsState.process.send(command);
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				console.error(`[SubprocessManager] Failed to send to metrics subprocess: ${msg}`);
			}
		}
	}

	/**
	 * Send command to events subprocess
	 */
	private sendToEvents(command: MainProcessCommand): void {
		if (this.eventsState.process) {
			try {
				this.eventsState.process.send(command);
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				console.error(`[SubprocessManager] Failed to send to events subprocess: ${msg}`);
			}
		}
	}

	/**
	 * Get metrics subprocess PID (for HMR cleanup)
	 */
	getMetricsPid(): number | null {
		return this.metricsState.process?.pid ?? null;
	}

	/**
	 * Get events subprocess PID (for HMR cleanup)
	 */
	getEventsPid(): number | null {
		return this.eventsState.process?.pid ?? null;
	}
}

// Singleton instance
let manager: SubprocessManager | null = null;

// Store PIDs globally to survive HMR reloads
// Using globalThis to persist across module reloads in dev mode
const GLOBAL_KEY = '__dockhand_subprocess_pids__';
interface SubprocessPids {
	metrics: number | null;
	events: number | null;
}

function getStoredPids(): SubprocessPids {
	return (globalThis as any)[GLOBAL_KEY] || { metrics: null, events: null };
}

function setStoredPids(pids: SubprocessPids): void {
	(globalThis as any)[GLOBAL_KEY] = pids;
}

/**
 * Kill any orphaned processes from previous HMR reloads
 */
function killOrphanedProcesses(): void {
	const pids = getStoredPids();

	if (pids.metrics) {
		try {
			process.kill(pids.metrics, 'SIGTERM');
			console.log(`[SubprocessManager] Killed orphaned metrics process (PID: ${pids.metrics})`);
		} catch {
			// Process already dead, ignore
		}
	}

	if (pids.events) {
		try {
			process.kill(pids.events, 'SIGTERM');
			console.log(`[SubprocessManager] Killed orphaned events process (PID: ${pids.events})`);
		} catch {
			// Process already dead, ignore
		}
	}

	setStoredPids({ metrics: null, events: null });
}

/**
 * Start background subprocesses
 */
export async function startSubprocesses(): Promise<void> {
	// Kill any orphaned processes from HMR reloads
	killOrphanedProcesses();

	if (manager) {
		console.warn('[SubprocessManager] Subprocesses already started');
		return;
	}

	manager = new SubprocessManager();
	await manager.start();

	// Store PIDs for HMR cleanup
	setStoredPids({
		metrics: manager.getMetricsPid(),
		events: manager.getEventsPid()
	});
}

/**
 * Stop background subprocesses
 */
export async function stopSubprocesses(): Promise<void> {
	if (manager) {
		await manager.stop();
		manager = null;
	}
	setStoredPids({ metrics: null, events: null });
}

/**
 * Notify subprocesses to refresh environments
 */
export function refreshSubprocessEnvironments(): void {
	if (manager) {
		manager.refreshEnvironments();
	}
}

/**
 * Send message to event subprocess
 */
export function sendToEventSubprocess(message: MainProcessCommand): void {
	if (manager) {
		manager.sendToEventsSubprocess(message);
	}
}

/**
 * Send message to metrics subprocess
 */
export function sendToMetricsSubprocess(message: MainProcessCommand): void {
	if (manager) {
		manager.sendToMetricsSubprocess(message);
	}
}
