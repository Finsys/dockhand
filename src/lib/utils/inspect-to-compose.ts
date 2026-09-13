/**
 * Turn a Docker inspect payload into a single-service docker-compose fragment.
 *
 * Source of truth is the inspect JSON (Config + HostConfig + NetworkSettings + Mounts),
 * not a reconstructed `docker run` line. Only fields the user could have set are emitted:
 * daemon-injected defaults (empty entrypoint, `NetworkMode: default`, an empty restart
 * policy) and compose-managed labels (`com.docker.compose.*`) are dropped so the output
 * reads like a compose file a human would write.
 *
 * Pure and dependency-light (js-yaml only) so it is unit-testable without a daemon.
 */
import yaml from 'js-yaml';

/** The slice of a Docker inspect object this mapper reads (loosely typed on purpose). */
export interface DockerInspect {
	Name?: string;
	Config?: {
		Image?: string;
		Cmd?: string[] | null;
		Entrypoint?: string[] | null;
		Env?: string[] | null;
		Labels?: Record<string, string> | null;
		User?: string;
		WorkingDir?: string;
		Hostname?: string;
		Domainname?: string;
		OpenStdin?: boolean;
		Tty?: boolean;
		StopSignal?: string;
		StopTimeout?: number | null;
		ExposedPorts?: Record<string, unknown> | null;
		Healthcheck?: {
			Test?: string[];
			Interval?: number;
			Timeout?: number;
			Retries?: number;
			StartPeriod?: number;
		} | null;
	};
	HostConfig?: {
		RestartPolicy?: { Name?: string; MaximumRetryCount?: number };
		PortBindings?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null> | null;
		Binds?: string[] | null;
		CapAdd?: string[] | null;
		CapDrop?: string[] | null;
		Privileged?: boolean;
		ReadonlyRootfs?: boolean;
		NetworkMode?: string;
		IpcMode?: string;
		PidMode?: string;
		UsernsMode?: string;
		CgroupParent?: string;
		Runtime?: string;
		Init?: boolean | null;
		ShmSize?: number;
		Dns?: string[] | null;
		DnsSearch?: string[] | null;
		DnsOptions?: string[] | null;
		ExtraHosts?: string[] | null;
		GroupAdd?: string[] | null;
		SecurityOpt?: string[] | null;
		VolumesFrom?: string[] | null;
		OomKillDisable?: boolean | null;
		OomScoreAdj?: number;
		Memory?: number;
		MemoryReservation?: number;
		MemorySwap?: number;
		NanoCpus?: number;
		CpuShares?: number;
		CpusetCpus?: string;
		PidsLimit?: number | null;
		Devices?: Array<{ PathOnHost: string; PathInContainer: string; CgroupPermissions?: string }> | null;
		Sysctls?: Record<string, string> | null;
		Tmpfs?: Record<string, string> | null;
		Ulimits?: Array<{ Name: string; Soft: number; Hard: number }> | null;
		LogConfig?: { Type?: string; Config?: Record<string, string> | null };
	};
	NetworkSettings?: {
		Networks?: Record<
			string,
			{
				Aliases?: string[] | null;
				MacAddress?: string;
				IPAMConfig?: { IPv4Address?: string; IPv6Address?: string } | null;
			} | null
		> | null;
	};
	Mounts?: Array<{
		Type?: string;
		Name?: string;
		Source?: string;
		Destination?: string;
		RW?: boolean;
	}> | null;
}

export interface InspectToComposeOptions {
	/**
	 * The image's own `Config.Env` (from inspecting the image). When given, env vars whose
	 * `KEY=VALUE` matches the image verbatim are dropped, so the compose keeps only the
	 * vars the user actually set. Omit to keep every env var.
	 */
	imageEnv?: string[] | null;
	/** The image's own `Config.Entrypoint`. When it matches the container's, entrypoint is dropped (image default). */
	imageEntrypoint?: string[] | null;
	/** The image's own `Config.Cmd`. When it matches the container's, command is dropped (image default). */
	imageCmd?: string[] | null;
	/** The image's own `Config.Labels`. Labels whose value matches the image are dropped (image-baked, e.g. `maintainer`). */
	imageLabels?: Record<string, string> | null;
	/** The image's own `Config.ExposedPorts`. Ports the image itself EXPOSEs are dropped from `expose:`. */
	imageExposedPorts?: Record<string, unknown> | null;
	/** Override the service key (defaults to the container name). */
	serviceName?: string;
}

/** Networks Docker always has; a container on one of these alone has no user-set network. */
const DEFAULT_NETWORKS = new Set(['bridge', 'host', 'none', 'default']);

/**
 * Per-network compose config from a container's NetworkSettings.Networks entry. Keeps only
 * user-set detail: static IP (IPAMConfig), a per-network MAC, and EXTRA aliases. Docker/compose
 * auto-add three aliases that are NOT user-set and would be noise: the service key we emit, the
 * 12-hex short container id, and (for a compose-managed container) the `com.docker.compose.service`
 * name. Returns null when the network carries nothing worth emitting (a bare attachment).
 */
function networkConfig(
	info: { Aliases?: string[] | null; MacAddress?: string; IPAMConfig?: { IPv4Address?: string; IPv6Address?: string } | null } | null,
	serviceName: string,
	composeServiceName?: string
): Record<string, unknown> | null {
	if (!info) return null;
	const cfg: Record<string, unknown> = {};
	const v4 = info.IPAMConfig?.IPv4Address;
	const v6 = info.IPAMConfig?.IPv6Address;
	if (v4) cfg.ipv4_address = v4;
	if (v6) cfg.ipv6_address = v6;
	const auto = new Set([serviceName, composeServiceName].filter(Boolean) as string[]);
	const aliases = (info.Aliases ?? []).filter((a) => !auto.has(a) && !/^[0-9a-f]{12}$/.test(a));
	if (aliases.length > 0) cfg.aliases = aliases;
	if (info.MacAddress) cfg.mac_address = info.MacAddress;
	return Object.keys(cfg).length > 0 ? cfg : null;
}

/**
 * NetworkMode values that mean "Docker's default bridge networking" - emitting them adds
 * nothing. `host`/`none`/`container:x`/a service name are deliberate modes and ARE emitted.
 */
const DEFAULT_NETWORK_MODES = new Set(['default', 'bridge']);

/**
 * A 64-char hex name is Docker's auto-generated ANONYMOUS volume id (it carries the
 * `com.docker.volume.anonymous` label, not visible in the container inspect). Such a
 * name won't reproduce, so it maps to an anonymous compose volume (`- /dest`) instead.
 */
function isAnonymousVolumeName(name: string): boolean {
	return /^[0-9a-f]{64}$/.test(name);
}

/** Element-wise string-array equality (order matters), treating null/undefined as empty. */
function arraysEqual(a: string[] | null | undefined, b: string[] | null | undefined): boolean {
	const x = a ?? [];
	const y = b ?? [];
	return x.length === y.length && x.every((v, i) => v === y[i]);
}

/** Strip the leading slash Docker puts on container names. */
function cleanName(name: string | undefined): string {
	if (!name) return 'app';
	return name.startsWith('/') ? name.slice(1) : name;
}

/** `["80/tcp"] -> "80"`, `"53/udp" -> "53/udp"` (keep the proto only when not tcp). */
function portSpec(containerPort: string, bindings: Array<{ HostIp?: string; HostPort?: string }> | null): string[] {
	const [port, proto] = containerPort.split('/');
	const suffix = proto && proto !== 'tcp' ? `/${proto}` : '';
	if (!bindings || bindings.length === 0) {
		// Exposed but not published (no host binding) -> "expose" style single value.
		return [`${port}${suffix}`];
	}
	return bindings.map((b) => {
		const host = b.HostPort ? b.HostPort : port;
		const ip = b.HostIp && b.HostIp !== '0.0.0.0' && b.HostIp !== '::' ? `${b.HostIp}:` : '';
		return `${ip}${host}:${port}${suffix}`;
	});
}

/**
 * Escape `$` -> `$$` in the VALUE half of a `KEY=VALUE` env entry so `docker compose`
 * does not interpolate it (#1507). Inspect values are already resolved literals (the
 * daemon expanded any real variable), so every `$` must survive verbatim - e.g. a
 * bcrypt hash `$2a$12$...` would otherwise be read as variable references and mangled.
 * Only the value is escaped; the key never contains `$`.
 */
function escapeEnvEntryForCompose(entry: string): string {
	const eq = entry.indexOf('=');
	if (eq < 0) return entry;
	const key = entry.slice(0, eq);
	const value = entry.slice(eq + 1);
	return `${key}=${value.replace(/\$/g, '$$$$')}`;
}

/** Convert a nanosecond duration (Docker healthcheck) to a compose `30s` string. */
function nsToDuration(ns: number | undefined): string | undefined {
	if (!ns || ns <= 0) return undefined;
	const seconds = ns / 1e9;
	return `${seconds}s`;
}

/**
 * Build the compose object for a single service from a container inspect.
 * Returns a plain object keyed by the service name (ready to merge or serialize).
 */
export function inspectToComposeService(
	inspect: DockerInspect,
	options: InspectToComposeOptions = {}
): { name: string; service: Record<string, unknown>; namedVolumes: string[] } {
	const config = inspect.Config ?? {};
	const host = inspect.HostConfig ?? {};
	const name = options.serviceName ?? cleanName(inspect.Name);
	const composeServiceName = config.Labels?.['com.docker.compose.service'];
	const service: Record<string, unknown> = {};

	if (config.Image) service.image = config.Image;
	service.container_name = name;

	// Entrypoint / command: drop them when they equal the image's own (an image default the
	// user never overrode) - keeping them pins the current image's baked-in entrypoint and
	// gets in the way of an image bump.
	if (
		Array.isArray(config.Entrypoint) &&
		config.Entrypoint.length > 0 &&
		!arraysEqual(config.Entrypoint, options.imageEntrypoint)
	) {
		service.entrypoint = config.Entrypoint;
	}
	if (Array.isArray(config.Cmd) && config.Cmd.length > 0 && !arraysEqual(config.Cmd, options.imageCmd)) {
		service.command = config.Cmd;
	}

	// Environment: drop image-baked vars when the image env is provided.
	if (Array.isArray(config.Env) && config.Env.length > 0) {
		const imageEnv = new Set(options.imageEnv ?? []);
		const env = config.Env.filter((e) => !imageEnv.has(e)).map(escapeEnvEntryForCompose);
		if (env.length > 0) service.environment = env;
	}

	// Labels: never the compose-managed ones (runtime bookkeeping), and drop labels the
	// image already sets to the same value (e.g. `maintainer`, `org.opencontainers.*`) so
	// only user-set labels remain.
	if (config.Labels) {
		const imageLabels = options.imageLabels ?? {};
		const labels = Object.entries(config.Labels).filter(
			([k, v]) => !k.startsWith('com.docker.compose.') && imageLabels[k] !== v
		);
		if (labels.length > 0) service.labels = Object.fromEntries(labels);
	}

	// Ports from published bindings (+ merely-exposed ports with no host binding).
	if (host.PortBindings && Object.keys(host.PortBindings).length > 0) {
		const ports: string[] = [];
		for (const [cp, binds] of Object.entries(host.PortBindings)) {
			ports.push(...portSpec(cp, binds ?? null));
		}
		if (ports.length > 0) service.ports = ports;
	}

	// Volumes from Mounts: named -> `name:dest`, anonymous named -> `dest` (bare), bind ->
	// `source:dest`, `:ro` when read-only. Named volumes are collected so the caller can
	// declare them at the top level (compose requires it).
	const namedVolumes: string[] = [];
	if (Array.isArray(inspect.Mounts) && inspect.Mounts.length > 0) {
		const volumes: string[] = [];
		for (const m of inspect.Mounts) {
			if (!m.Destination) continue;
			const suffix = m.RW === false ? ':ro' : '';
			if (m.Type === 'volume' && m.Name) {
				if (isAnonymousVolumeName(m.Name)) {
					volumes.push(`${m.Destination}${suffix}`); // anonymous volume, no reusable name
				} else {
					volumes.push(`${m.Name}:${m.Destination}${suffix}`);
					namedVolumes.push(m.Name);
				}
			} else if (m.Type === 'bind' && m.Source) {
				volumes.push(`${m.Source}:${m.Destination}${suffix}`);
			}
		}
		if (volumes.length > 0) service.volumes = volumes;
	}

	// Restart policy: skip the empty default and the explicit "no".
	const restart = host.RestartPolicy?.Name;
	if (restart && restart !== 'no') {
		if (restart === 'on-failure' && host.RestartPolicy?.MaximumRetryCount) {
			service.restart = `on-failure:${host.RestartPolicy.MaximumRetryCount}`;
		} else {
			service.restart = restart;
		}
	}

	// Networks: a container on real (non-default) networks gets `networks:`. Each network keeps
	// its user-set details (static IP, extra aliases, per-network MAC); a bare network is left
	// null. If NO network carries any detail we emit the short list form (zero noise); otherwise
	// the map form. A non-default `network_mode` (host / none / container:x / a service name) is
	// emitted instead, only when the container has no real networks.
	const netEntries = Object.entries(inspect.NetworkSettings?.Networks ?? {}).filter(
		([n]) => !DEFAULT_NETWORKS.has(n)
	);
	if (netEntries.length > 0) {
		const configs = netEntries.map(([n, info]) => [n, networkConfig(info, name, composeServiceName)] as const);
		const anyDetail = configs.some(([, cfg]) => cfg !== null);
		service.networks = anyDetail
			? Object.fromEntries(configs)
			: configs.map(([n]) => n);
	} else {
		const mode = host.NetworkMode;
		if (mode && !DEFAULT_NETWORK_MODES.has(mode)) service.network_mode = mode;
	}

	if (host.CapAdd && host.CapAdd.length > 0) service.cap_add = host.CapAdd;
	if (host.CapDrop && host.CapDrop.length > 0) service.cap_drop = host.CapDrop;
	if (host.Privileged) service.privileged = true;
	if (host.ReadonlyRootfs) service.read_only = true;

	if (Array.isArray(host.Devices) && host.Devices.length > 0) {
		service.devices = host.Devices.map((d) => {
			const perms = d.CgroupPermissions && d.CgroupPermissions !== 'rwm' ? `:${d.CgroupPermissions}` : '';
			return `${d.PathOnHost}:${d.PathInContainer}${perms}`;
		});
	}

	if (host.Sysctls && Object.keys(host.Sysctls).length > 0) service.sysctls = host.Sysctls;
	if (host.Tmpfs && Object.keys(host.Tmpfs).length > 0) service.tmpfs = Object.keys(host.Tmpfs);
	if (host.Dns && host.Dns.length > 0) service.dns = host.Dns;
	if (host.DnsSearch && host.DnsSearch.length > 0) service.dns_search = host.DnsSearch;
	if (host.DnsOptions && host.DnsOptions.length > 0) service.dns_opt = host.DnsOptions;
	if (host.ExtraHosts && host.ExtraHosts.length > 0) service.extra_hosts = host.ExtraHosts;

	if (Array.isArray(host.Ulimits) && host.Ulimits.length > 0) {
		service.ulimits = Object.fromEntries(
			host.Ulimits.map((u) => [u.Name, u.Soft === u.Hard ? u.Soft : { soft: u.Soft, hard: u.Hard }])
		);
	}

	// Logging: skip the default json-file driver with no options (compose default).
	const logDriver = host.LogConfig?.Type;
	const logOpts = host.LogConfig?.Config;
	if (logDriver && (logDriver !== 'json-file' || (logOpts && Object.keys(logOpts).length > 0))) {
		const logging: Record<string, unknown> = { driver: logDriver };
		if (logOpts && Object.keys(logOpts).length > 0) logging.options = logOpts;
		service.logging = logging;
	}

	if (config.User) service.user = config.User;
	if (config.WorkingDir && config.WorkingDir !== '/') service.working_dir = config.WorkingDir;
	// Docker always stamps a hostname; skip the auto-generated one (equals the short
	// container id, a 12-hex string) - only a user-set hostname is worth emitting.
	if (config.Hostname && config.Hostname !== name && !/^[0-9a-f]{12}$/.test(config.Hostname)) {
		service.hostname = config.Hostname;
	}
	if (host.IpcMode && host.IpcMode !== 'private' && host.IpcMode !== '') service.ipc = host.IpcMode;
	if (config.OpenStdin) service.stdin_open = true;
	if (config.Tty) service.tty = true;

	// Resource limits: emit the TOP-LEVEL standalone compose keys (docker compose up honors them
	// on a plain container; `deploy.resources` is swarm-only). Each skips its daemon default.
	if (host.Memory && host.Memory > 0) service.mem_limit = host.Memory;
	if (host.MemoryReservation && host.MemoryReservation > 0) service.mem_reservation = host.MemoryReservation;
	// MemorySwap: -1 = unlimited swap, 0 = unset; only meaningful alongside a memory limit.
	if (host.MemorySwap && (host.MemorySwap > 0 || host.MemorySwap === -1)) service.memswap_limit = host.MemorySwap;
	// NanoCpus is nano-cores; compose `cpus` is a decimal core count.
	if (host.NanoCpus && host.NanoCpus > 0) service.cpus = host.NanoCpus / 1e9;
	// CpuShares: default 0, and 1024 is the daemon's neutral weight - neither is user intent.
	if (host.CpuShares && host.CpuShares !== 1024) service.cpu_shares = host.CpuShares;
	if (host.CpusetCpus && host.CpusetCpus !== '') service.cpuset = host.CpusetCpus;
	// PidsLimit: 0/null = unset, -1 = unlimited (the default); emit only a real positive cap.
	if (host.PidsLimit && host.PidsLimit > 0) service.pids_limit = host.PidsLimit;

	// Lifecycle: stop signal/grace, ports EXPOSEd-but-not-published, supplementary groups, init.
	if (config.StopSignal && config.StopSignal !== 'SIGTERM') service.stop_signal = config.StopSignal;
	if (typeof config.StopTimeout === 'number' && config.StopTimeout > 0) {
		service.stop_grace_period = `${config.StopTimeout}s`;
	}
	const exposed = config.ExposedPorts ? Object.keys(config.ExposedPorts) : [];
	if (exposed.length > 0) {
		const published = new Set(Object.keys(host.PortBindings ?? {}));
		const imageExposed = new Set(Object.keys(options.imageExposedPorts ?? {}));
		// Only ports with NO host binding that the image itself did not already EXPOSE.
		const expose = exposed
			.filter((p) => !published.has(p) && !imageExposed.has(p))
			.map((p) => {
				const [port, proto] = p.split('/');
				return proto && proto !== 'tcp' ? `${port}/${proto}` : port;
			});
		if (expose.length > 0) service.expose = expose;
	}
	if (host.GroupAdd && host.GroupAdd.length > 0) service.group_add = host.GroupAdd;
	if (host.Init === true) service.init = true;

	// Runtime/security options (niche but real user intent); each skips its daemon default.
	if (host.SecurityOpt && host.SecurityOpt.length > 0) service.security_opt = host.SecurityOpt;
	if (host.PidMode && host.PidMode !== '') service.pid = host.PidMode;
	if (host.UsernsMode && host.UsernsMode !== '') service.userns_mode = host.UsernsMode;
	if (host.CgroupParent && host.CgroupParent !== '') service.cgroup_parent = host.CgroupParent;
	// Runtime: runc is the default; nvidia/runsc/kata are deliberate.
	if (host.Runtime && host.Runtime !== '' && host.Runtime !== 'runc') service.runtime = host.Runtime;
	// shm_size: Docker's default is a fixed 64 MiB (67108864); emit only a differing value.
	if (host.ShmSize && host.ShmSize > 0 && host.ShmSize !== 67108864) service.shm_size = host.ShmSize;
	if (host.VolumesFrom && host.VolumesFrom.length > 0) service.volumes_from = host.VolumesFrom;
	if (host.OomKillDisable === true) service.oom_kill_disable = true;
	if (host.OomScoreAdj && host.OomScoreAdj !== 0) service.oom_score_adj = host.OomScoreAdj;
	if (config.Domainname && config.Domainname !== '') service.domainname = config.Domainname;

	// Healthcheck: a real Test (not the image-inherited empty / NONE) maps to compose form.
	const hc = config.Healthcheck;
	if (hc && Array.isArray(hc.Test) && hc.Test.length > 0 && hc.Test[0] !== 'NONE') {
		const healthcheck: Record<string, unknown> = {};
		// Test is ["CMD-SHELL", "..."] or ["CMD", "arg", ...]; compose `test` mirrors it.
		healthcheck.test = hc.Test;
		const interval = nsToDuration(hc.Interval);
		const timeout = nsToDuration(hc.Timeout);
		const startPeriod = nsToDuration(hc.StartPeriod);
		if (interval) healthcheck.interval = interval;
		if (timeout) healthcheck.timeout = timeout;
		if (hc.Retries) healthcheck.retries = hc.Retries;
		if (startPeriod) healthcheck.start_period = startPeriod;
		service.healthcheck = healthcheck;
	}

	return { name, service, namedVolumes };
}

/**
 * Full compose document (`services:` + top-level `networks:`/`volumes:` for the named
 * networks/volumes the service references) as a YAML string. Both are declared
 * `external: true` because they already exist on the host - the user can flip that if
 * they want compose to create them.
 */
export function inspectToCompose(inspect: DockerInspect, options: InspectToComposeOptions = {}): string {
	const { name, service, namedVolumes } = inspectToComposeService(inspect, options);
	const doc: Record<string, unknown> = { services: { [name]: service } };

	// service.networks is either a string[] (bare) or a map {name: {ipv4_address,...}}; the
	// top-level declaration just needs the names, each marked external (they already exist).
	const svcNetworks = service.networks as string[] | Record<string, unknown> | undefined;
	const networkNames = Array.isArray(svcNetworks)
		? svcNetworks
		: svcNetworks
			? Object.keys(svcNetworks)
			: [];
	if (networkNames.length > 0) {
		doc.networks = Object.fromEntries(networkNames.map((n) => [n, { external: true }]));
	}

	if (namedVolumes.length > 0) {
		doc.volumes = Object.fromEntries(namedVolumes.map((v) => [v, { external: true }]));
	}

	return yaml.dump(doc, { lineWidth: -1, noRefs: true, sortKeys: false });
}
