import { setGlobalDispatcher, Agent, EnvHttpProxyAgent } from 'undici';
import dns from 'node:dns';
import net from 'node:net';

const origLookup = dns.lookup.bind(dns);

// DNS_RESULT_ORDER lets operators opt out of Dockhand's default IPv4-first pinning.
//
// By default Dockhand forces IPv4 (entrypoint: --dns-result-order=ipv4first
// --no-network-family-autoselection) so outbound fetch never tries IPv6 on Docker
// networks that lack IPv6 routing (#676 — each IPv6 attempt would hang and eat the
// connect timeout). On hosts where the CONTAINER's IPv4 egress is broken while IPv6
// works (a firewall dropping bridged IPv4, or a dual-stack setup), that pinning
// guarantees `fetch failed` even though IPv6 would succeed (#1293, #777, #1115).
//
// Setting DNS_RESULT_ORDER=verbatim (or ipv6first) re-enables the OS-native order
// plus Happy Eyeballs and, crucially, SKIPS Dockhand's custom IPv4-only DNS
// dispatcher entirely — falling back to plain undici + Node's native resolver. This
// keeps the risky path opt-in: unset (the default) runs the exact same code as before.
const DNS_RESULT_ORDER = (process.env.DNS_RESULT_ORDER || '').trim().toLowerCase();
const ALLOW_IPV6 = DNS_RESULT_ORDER === 'verbatim' || DNS_RESULT_ORDER === 'ipv6first';

// DNS cache: hostname → { address, family, expiresAt } (positive)
// DNS negative cache: hostname → { error, expiresAt } (failed lookups)
const dnsCache = new Map<string, { address: string; family: number; expiresAt: number }>();
const dnsNegCache = new Map<string, { error: Error; expiresAt: number }>();
const DNS_TTL_MS = 30_000;
const DNS_NEG_TTL_MS = 10_000; // Cache failures for 10s to prevent DNS server storms

// In-flight deduplication: hostname → pending Promise<{address, family}>
const inFlight = new Map<string, Promise<{ address: string; family: number }>>();

function lookupWithCache(hostname: string): Promise<{ address: string; family: number }> {
	// Positive cache hit
	const cached = dnsCache.get(hostname);
	if (cached) {
		if (cached.expiresAt > Date.now()) {
			return Promise.resolve({ address: cached.address, family: cached.family });
		}
		dnsCache.delete(hostname); // evict stale entry
	}

	// Negative cache hit — don't hammer DNS for recently-failed hostnames
	const negCached = dnsNegCache.get(hostname);
	if (negCached) {
		if (negCached.expiresAt > Date.now()) {
			return Promise.reject(negCached.error);
		}
		dnsNegCache.delete(hostname);
	}

	// In-flight deduplication
	const pending = inFlight.get(hostname);
	if (pending) return pending;

	// Use getaddrinfo (libc) as primary — works through Docker's embedded DNS (127.0.0.11)
	// and respects --dns-result-order=ipv4first from entrypoint. This matches Bun's native
	// behavior which worked reliably on NAS environments where c-ares failed (#676).
	const promise = new Promise<{ address: string; family: number }>((resolve, reject) => {
		origLookup(hostname, { all: false }, (err, address, family) => {
			if (err) {
				// Cache the failure so parallel/subsequent requests don't all hammer DNS
				dnsNegCache.set(hostname, { error: err, expiresAt: Date.now() + DNS_NEG_TTL_MS });
				reject(err);
			} else {
				const result = { address: address as string, family: family as number };
				dnsCache.set(hostname, { ...result, expiresAt: Date.now() + DNS_TTL_MS });
				resolve(result);
			}
		});
	}).finally(() => {
		inFlight.delete(hostname);
	});

	inFlight.set(hostname, promise);
	return promise;
}

// Shared connect options for DNS lookup
const connectOptions = {
	// Undici default is 10s. Increase to 30s for NAS environments with slow NAT/firewalls (#676).
	timeout: 30_000,
	lookup(hostname: string, opts: any, cb: any) {
		if (typeof opts === 'function') {
			cb = opts;
			opts = {};
		}

		// IP addresses / localhost → no DNS needed
		if (net.isIP(hostname) || hostname === 'localhost') {
			return origLookup(hostname, opts, cb);
		}

		lookupWithCache(hostname)
			.then(({ address, family }) => {
				if (opts.all) {
					cb(null, [{ address, family }]);
				} else {
					cb(null, address, family);
				}
			})
			.catch((err) => cb(err));
	}
};

// Use EnvHttpProxyAgent when HTTP(S)_PROXY env vars are set, otherwise plain Agent.
// Node.js fetch/undici does NOT respect proxy env vars by default — EnvHttpProxyAgent
// reads HTTP_PROXY, HTTPS_PROXY, and NO_PROXY automatically.
const hasProxy = process.env.HTTP_PROXY || process.env.HTTPS_PROXY ||
	process.env.http_proxy || process.env.https_proxy;

if (ALLOW_IPV6) {
	// Opt-in IPv6 fallback: undo the entrypoint's IPv4 pinning from within the process
	// (both flags are overridable at runtime — verified) and DON'T install the custom
	// IPv4-only dispatcher. Plain undici + Node's native resolver then honors the
	// OS-native order and Happy Eyeballs, so a dead IPv4 path falls back to IPv6.
	try {
		dns.setDefaultResultOrder(DNS_RESULT_ORDER as 'verbatim' | 'ipv6first');
		net.setDefaultAutoSelectFamily(true);
	} catch (e) {
		console.warn(`[DNS] Could not apply DNS_RESULT_ORDER=${DNS_RESULT_ORDER}:`, e);
	}
	console.log(`[DNS] DNS_RESULT_ORDER=${DNS_RESULT_ORDER} — IPv6 fallback enabled, using native resolver`);
	if (hasProxy) {
		const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy ||
			process.env.HTTP_PROXY || process.env.http_proxy;
		console.log(`[DNS] HTTP proxy detected (${proxyUrl}), using EnvHttpProxyAgent`);
		setGlobalDispatcher(new EnvHttpProxyAgent());
	}
	// else: leave undici's built-in global dispatcher untouched.
} else if (hasProxy) {
	const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy ||
		process.env.HTTP_PROXY || process.env.http_proxy;
	console.log(`[DNS] HTTP proxy detected (${proxyUrl}), using EnvHttpProxyAgent`);
	setGlobalDispatcher(new EnvHttpProxyAgent({ connect: connectOptions }));
} else {
	setGlobalDispatcher(new Agent({ connect: connectOptions }));
}
