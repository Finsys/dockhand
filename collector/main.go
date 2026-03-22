// Collection worker for Dockhand.
//
// A lightweight Go binary that handles background Docker API calls for
// metrics collection, event streaming, and disk usage checks.
// Communicates with the Node.js parent process via JSON lines on
// stdin (commands) and stdout (results).
package main

import (
	"bufio"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"
)

// ---------------------------------------------------------------------------
// IPC message types
// ---------------------------------------------------------------------------

// Inbound (stdin) messages from Node.js parent.
type InMessage struct {
	Type           string     `json:"type"`
	EnvID          int        `json:"envId,omitempty"`
	Name           string     `json:"name,omitempty"`
	Config         *EnvConfig `json:"config,omitempty"`
	ConnectionType string     `json:"connectionType,omitempty"`
	HawserToken    string     `json:"hawserToken,omitempty"`
	IntervalMs     int        `json:"intervalMs,omitempty"`
	Mode           string     `json:"mode,omitempty"`
	PollIntervalMs int        `json:"pollIntervalMs,omitempty"`
}

type EnvConfig struct {
	Type       string `json:"type"` // "socket", "http", "https"
	SocketPath string `json:"socketPath,omitempty"`
	Host       string `json:"host,omitempty"`
	Port       int    `json:"port,omitempty"`
	CA         string `json:"ca,omitempty"`
	Cert       string `json:"cert,omitempty"`
	Key        string `json:"key,omitempty"`
	SkipVerify bool   `json:"skipVerify,omitempty"`
}

// Outbound (stdout) messages to Node.js parent.
type OutMessage struct {
	Type  string          `json:"type"`
	EnvID int             `json:"envId,omitempty"`
	// Status
	Online *bool  `json:"online,omitempty"`
	Error  string `json:"error,omitempty"`
	// Events
	Event json.RawMessage `json:"event,omitempty"`
	// Disk
	Data json.RawMessage `json:"data,omitempty"`
	Info json.RawMessage `json:"info,omitempty"`
	// Metrics
	CPU      *float64 `json:"cpu,omitempty"`
	MemPct   *float64 `json:"memPercent,omitempty"`
	MemUsed  *int64   `json:"memUsed,omitempty"`
	MemTotal *int64   `json:"memTotal,omitempty"`
	CPUCount *int     `json:"cpuCount,omitempty"`
}

// ---------------------------------------------------------------------------
// Docker API response types (minimal, only what we need)
// ---------------------------------------------------------------------------

type containerInfo struct {
	ID    string `json:"Id"`
	State string `json:"State"`
}

type containerStats struct {
	CPUStats struct {
		CPUUsage struct {
			TotalUsage uint64 `json:"total_usage"`
		} `json:"cpu_usage"`
		SystemCPUUsage uint64 `json:"system_cpu_usage"`
		OnlineCPUs     int    `json:"online_cpus"`
	} `json:"cpu_stats"`
	PrecpuStats struct {
		CPUUsage struct {
			TotalUsage uint64 `json:"total_usage"`
		} `json:"cpu_usage"`
		SystemCPUUsage uint64 `json:"system_cpu_usage"`
	} `json:"precpu_stats"`
	MemoryStats struct {
		Usage uint64 `json:"usage"`
		Stats struct {
			InactiveFile      uint64 `json:"inactive_file"`
			TotalInactiveFile uint64 `json:"total_inactive_file"`
		} `json:"stats"`
	} `json:"memory_stats"`
}

type dockerInfo struct {
	MemTotal int64 `json:"MemTotal"`
	NCPU     int   `json:"NCPU"`
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const statsConcurrency = 8 // Max parallel stats calls per environment

// ---------------------------------------------------------------------------
// Environment manager
// ---------------------------------------------------------------------------

type environment struct {
	id             int
	name           string
	connectionType string
	hawserToken    string
	client         *http.Client
	streamClient   *http.Client
	transport      *http.Transport
	streamTransport *http.Transport
	baseURL        string
	cancel         context.CancelFunc
	ctx            context.Context
	online         bool
	statusReported bool // true after first env_status message sent
}

// closeTransports releases idle connections held by the environment's HTTP transports.
// Must be called when an environment is removed or reconfigured to prevent connection pool leaks.
func (e *environment) closeTransports() {
	if e.transport != nil {
		e.transport.CloseIdleConnections()
	}
	if e.streamTransport != nil {
		e.streamTransport.CloseIdleConnections()
	}
}

type manager struct {
	mu              sync.Mutex
	envs            map[int]*environment
	metricsInterval time.Duration
	eventMode       string // "stream" or "poll"
	pollInterval    time.Duration
	diskInterval    time.Duration
	output          *json.Encoder
	outputMu        sync.Mutex
}

func newManager(output *json.Encoder) *manager {
	return &manager{
		envs:            make(map[int]*environment),
		metricsInterval: 30 * time.Second,
		eventMode:       "stream",
		pollInterval:    60 * time.Second,
		diskInterval:    5 * time.Minute,
		output:          output,
	}
}

func (m *manager) send(msg OutMessage) {
	m.outputMu.Lock()
	defer m.outputMu.Unlock()
	_ = m.output.Encode(msg)
}

func boolPtr(v bool) *bool          { return &v }
func float64Ptr(v float64) *float64 { return &v }
func int64Ptr(v int64) *int64       { return &v }
func intPtr(v int) *int             { return &v }

// drainAndClose discards a response body and closes it (for connection reuse).
func drainAndClose(resp *http.Response) {
	if resp != nil && resp.Body != nil {
		io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
	}
}

// ---------------------------------------------------------------------------
// Docker HTTP client construction
// ---------------------------------------------------------------------------

func buildClients(cfg *EnvConfig) (client *http.Client, streamClient *http.Client, tp *http.Transport, stp *http.Transport, baseURL string, err error) {
	var transport *http.Transport
	var streamTransport *http.Transport

	switch cfg.Type {
	case "socket":
		socketPath := cfg.SocketPath
		if socketPath == "" {
			socketPath = "/var/run/docker.sock"
		}
		dial := func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", socketPath)
		}
		transport = &http.Transport{
			DialContext:         dial,
			MaxIdleConns:        16,
			MaxIdleConnsPerHost: 16,
			MaxConnsPerHost:     16,
			IdleConnTimeout:     90 * time.Second,
		}
		streamTransport = &http.Transport{
			DialContext:         dial,
			MaxIdleConns:        4,
			MaxIdleConnsPerHost: 4,
			MaxConnsPerHost:     4,
			IdleConnTimeout:     0,
		}
		baseURL = "http://localhost"

	case "http":
		transport = &http.Transport{
			MaxIdleConns:        16,
			MaxIdleConnsPerHost: 16,
			MaxConnsPerHost:     16,
			IdleConnTimeout:     90 * time.Second,
		}
		streamTransport = &http.Transport{
			MaxIdleConns:        4,
			MaxIdleConnsPerHost: 4,
			MaxConnsPerHost:     4,
			IdleConnTimeout:     0,
		}
		baseURL = fmt.Sprintf("http://%s:%d", cfg.Host, cfg.Port)

	case "https":
		tlsCfg, tlsErr := buildTLSConfig(cfg)
		if tlsErr != nil {
			return nil, nil, nil, nil, "", tlsErr
		}
		streamTLSCfg := tlsCfg.Clone()

		transport = &http.Transport{
			TLSClientConfig:     tlsCfg,
			MaxIdleConns:        16,
			MaxIdleConnsPerHost: 16,
			MaxConnsPerHost:     16,
			IdleConnTimeout:     90 * time.Second,
		}
		streamTransport = &http.Transport{
			TLSClientConfig:     streamTLSCfg,
			MaxIdleConns:        4,
			MaxIdleConnsPerHost: 4,
			MaxConnsPerHost:     4,
			IdleConnTimeout:     0,
		}
		baseURL = fmt.Sprintf("https://%s:%d", cfg.Host, cfg.Port)

	default:
		return nil, nil, nil, nil, "", fmt.Errorf("unsupported connection type: %s", cfg.Type)
	}

	client = &http.Client{Transport: transport, Timeout: 30 * time.Second}
	streamClient = &http.Client{Transport: streamTransport, Timeout: 0}
	return client, streamClient, transport, streamTransport, baseURL, nil
}

func buildTLSConfig(cfg *EnvConfig) (*tls.Config, error) {
	tlsCfg := &tls.Config{
		InsecureSkipVerify: cfg.SkipVerify,
		ServerName:         cfg.Host, // Explicit SNI for IP-based hosts
	}

	if cfg.CA != "" {
		// Start from system cert pool so intermediate CAs can chain to system roots
		pool, err := x509.SystemCertPool()
		if err != nil {
			pool = x509.NewCertPool()
		}
		if !pool.AppendCertsFromPEM([]byte(cfg.CA)) {
			return nil, fmt.Errorf("failed to parse CA certificate")
		}
		tlsCfg.RootCAs = pool
	}

	if cfg.Cert != "" && cfg.Key != "" {
		cert, err := tls.X509KeyPair([]byte(cfg.Cert), []byte(cfg.Key))
		if err != nil {
			return nil, fmt.Errorf("failed to parse client cert/key: %w", err)
		}
		tlsCfg.Certificates = []tls.Certificate{cert}
	}

	return tlsCfg, nil
}

// ---------------------------------------------------------------------------
// Docker API helpers
// ---------------------------------------------------------------------------

func (e *environment) doRequest(ctx context.Context, method, path string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, e.baseURL+path, nil)
	if err != nil {
		return nil, err
	}
	if e.hawserToken != "" {
		req.Header.Set("X-Hawser-Token", e.hawserToken)
	}
	return e.client.Do(req)
}

func (e *environment) doStreamRequest(ctx context.Context, method, path string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, e.baseURL+path, nil)
	if err != nil {
		return nil, err
	}
	if e.hawserToken != "" {
		req.Header.Set("X-Hawser-Token", e.hawserToken)
	}
	return e.streamClient.Do(req)
}

func (e *environment) ping(ctx context.Context) bool {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	resp, err := e.doRequest(ctx, "GET", "/_ping")
	if err != nil {
		return false
	}
	drainAndClose(resp)
	return resp.StatusCode == 200
}

// ---------------------------------------------------------------------------
// Metrics collection goroutine
// ---------------------------------------------------------------------------

func (m *manager) runMetrics(env *environment) {
	m.collectMetrics(env)

	ticker := time.NewTicker(m.metricsInterval)
	defer ticker.Stop()

	for {
		select {
		case <-env.ctx.Done():
			return
		case <-ticker.C:
			m.mu.Lock()
			interval := m.metricsInterval
			m.mu.Unlock()
			ticker.Reset(interval)
			m.collectMetrics(env)
		}
	}
}

func (m *manager) collectMetrics(env *environment) {
	if !env.ping(env.ctx) {
		if env.online || !env.statusReported {
			env.online = false
			env.statusReported = true
			m.send(OutMessage{Type: "env_status", EnvID: env.id, Online: boolPtr(false), Error: "Docker not reachable"})
		}
		return
	}

	if !env.online || !env.statusReported {
		env.online = true
		env.statusReported = true
		m.send(OutMessage{Type: "env_status", EnvID: env.id, Online: boolPtr(true)})
	}

	// List running containers
	ctx, cancel := context.WithTimeout(env.ctx, 15*time.Second)
	defer cancel()

	resp, err := env.doRequest(ctx, "GET", "/containers/json?all=false")
	if err != nil {
		m.send(OutMessage{Type: "error", EnvID: env.id, Error: fmt.Sprintf("list containers: %s", err)})
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode/100 != 2 {
		io.Copy(io.Discard, resp.Body)
		return
	}

	var containers []containerInfo
	if err := json.NewDecoder(resp.Body).Decode(&containers); err != nil {
		return
	}

	// Filter to running containers only
	running := make([]containerInfo, 0, len(containers))
	for _, c := range containers {
		if c.State == "running" {
			running = append(running, c)
		}
	}

	// Collect stats per container (parallel, bounded concurrency)
	type statsResult struct {
		cpu float64
		mem uint64
	}
	results := make([]statsResult, len(running))
	var wg sync.WaitGroup
	sem := make(chan struct{}, statsConcurrency)

	for i, c := range running {
		wg.Add(1)
		go func(idx int, id string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			sCtx, sCancel := context.WithTimeout(env.ctx, 10*time.Second)
			defer sCancel()

			sResp, sErr := env.doRequest(sCtx, "GET", fmt.Sprintf("/containers/%s/stats?stream=false&one-shot=true", id))
			if sErr != nil {
				return
			}
			defer sResp.Body.Close()

			if sResp.StatusCode/100 != 2 {
				io.Copy(io.Discard, sResp.Body)
				return
			}

			var stats containerStats
			if json.NewDecoder(sResp.Body).Decode(&stats) != nil {
				return
			}

			cpuDelta := float64(stats.CPUStats.CPUUsage.TotalUsage - stats.PrecpuStats.CPUUsage.TotalUsage)
			sysDelta := float64(stats.CPUStats.SystemCPUUsage - stats.PrecpuStats.SystemCPUUsage)
			cpuCount := stats.CPUStats.OnlineCPUs
			if cpuCount == 0 {
				cpuCount = 1
			}

			var cpuPct float64
			if sysDelta > 0 && cpuDelta > 0 {
				cpuPct = (cpuDelta / sysDelta) * float64(cpuCount) * 100
			}

			memUsage := stats.MemoryStats.Usage
			memCache := stats.MemoryStats.Stats.InactiveFile
			if memCache == 0 {
				memCache = stats.MemoryStats.Stats.TotalInactiveFile
			}
			actualMem := memUsage
			if memCache > 0 && memCache < memUsage {
				actualMem = memUsage - memCache
			}

			results[idx] = statsResult{cpu: cpuPct, mem: actualMem}
		}(i, c.ID)
	}
	wg.Wait()

	var totalCPU float64
	var totalMem uint64
	for _, r := range results {
		totalCPU += r.cpu
		totalMem += r.mem
	}

	// Get docker info for MemTotal and NCPU
	iCtx, iCancel := context.WithTimeout(env.ctx, 10*time.Second)
	defer iCancel()

	var info dockerInfo
	iResp, iErr := env.doRequest(iCtx, "GET", "/info")
	if iErr == nil {
		defer iResp.Body.Close()
		if iResp.StatusCode/100 == 2 {
			json.NewDecoder(iResp.Body).Decode(&info)
		} else {
			io.Copy(io.Discard, iResp.Body)
		}
	}

	memTotal := info.MemTotal
	cpuCount := info.NCPU
	if cpuCount == 0 {
		cpuCount = 1
	}

	normalizedCPU := totalCPU / float64(cpuCount)
	var memPct float64
	if memTotal > 0 {
		memPct = (float64(totalMem) / float64(memTotal)) * 100
	}

	if !math.IsNaN(normalizedCPU) && !math.IsInf(normalizedCPU, 0) && memTotal > 0 {
		m.send(OutMessage{
			Type:     "metrics",
			EnvID:    env.id,
			CPU:      float64Ptr(normalizedCPU),
			MemPct:   float64Ptr(memPct),
			MemUsed:  int64Ptr(int64(totalMem)),
			MemTotal: int64Ptr(memTotal),
			CPUCount: intPtr(cpuCount),
		})
	}
}

// ---------------------------------------------------------------------------
// Event streaming goroutine
// ---------------------------------------------------------------------------

func (m *manager) runEvents(env *environment) {
	reconnectDelay := 5 * time.Second
	maxReconnectDelay := 60 * time.Second

	// Reusable timer to avoid time.After leaks in select statements.
	// Stopped and drained between uses to prevent firing stale timers.
	delayTimer := time.NewTimer(0)
	if !delayTimer.Stop() {
		<-delayTimer.C
	}

	waitOrCancel := func(d time.Duration) bool {
		delayTimer.Reset(d)
		select {
		case <-env.ctx.Done():
			if !delayTimer.Stop() {
				<-delayTimer.C
			}
			return false
		case <-delayTimer.C:
			return true
		}
	}

	for {
		if env.ctx.Err() != nil {
			return
		}

		m.mu.Lock()
		mode := m.eventMode
		pollInterval := m.pollInterval
		m.mu.Unlock()

		if mode == "poll" {
			m.pollEvents(env)
			if !waitOrCancel(pollInterval) {
				return
			}
			continue
		}

		// Stream mode
		if !env.ping(env.ctx) {
			if env.online || !env.statusReported {
				env.online = false
				env.statusReported = true
				m.send(OutMessage{Type: "env_status", EnvID: env.id, Online: boolPtr(false), Error: "Docker not reachable"})
			}
			if !waitOrCancel(reconnectDelay) {
				return
			}
			reconnectDelay = minDuration(reconnectDelay*2, maxReconnectDelay)
			continue
		}

		if !env.online || !env.statusReported {
			env.online = true
			env.statusReported = true
			m.send(OutMessage{Type: "env_status", EnvID: env.id, Online: boolPtr(true)})
		}
		reconnectDelay = 5 * time.Second

		// Open event stream
		resp, err := env.doStreamRequest(env.ctx, "GET", "/events?type=container")
		if err != nil {
			if env.ctx.Err() != nil {
				return
			}
			env.online = false
			m.send(OutMessage{Type: "env_status", EnvID: env.id, Online: boolPtr(false), Error: err.Error()})
			if !waitOrCancel(reconnectDelay) {
				return
			}
			reconnectDelay = minDuration(reconnectDelay*2, maxReconnectDelay)
			continue
		}

		if resp.StatusCode/100 != 2 {
			drainAndClose(resp)
			if !waitOrCancel(reconnectDelay) {
				return
			}
			reconnectDelay = minDuration(reconnectDelay*2, maxReconnectDelay)
			continue
		}

		// Read events line-by-line with a bounded buffer.
		// Docker events are newline-delimited JSON; using bufio.Scanner
		// avoids json.Decoder's unbounded internal buffer growth.
		//
		// Force-close the body on context cancellation so scanner.Scan()
		// unblocks. Without this, the goroutine can leak if the transport's
		// internal cancel watcher doesn't fire (Go runtime implementation detail).
		bodyDone := make(chan struct{})
		go func() {
			select {
			case <-env.ctx.Done():
				resp.Body.Close()
			case <-bodyDone:
			}
		}()

		eventScanner := bufio.NewScanner(resp.Body)
		eventScanner.Buffer(make([]byte, 0, 64*1024), 1024*1024) // 64KB initial, 1MB max
		for eventScanner.Scan() {
			if env.ctx.Err() != nil {
				break
			}
			line := eventScanner.Bytes()
			if len(line) == 0 {
				continue
			}
			// Validate JSON and forward as raw message
			if json.Valid(line) {
				m.send(OutMessage{
					Type:  "container_event",
					EnvID: env.id,
					Event: json.RawMessage(append([]byte(nil), line...)),
				})
			}
		}
		close(bodyDone)
		resp.Body.Close()

		if env.ctx.Err() != nil {
			return
		}

		// Stream ended — reconnect
		if !waitOrCancel(reconnectDelay) {
			return
		}
		reconnectDelay = minDuration(reconnectDelay*2, maxReconnectDelay)
	}
}

func (m *manager) pollEvents(env *environment) {
	if !env.ping(env.ctx) {
		if env.online || !env.statusReported {
			env.online = false
			env.statusReported = true
			m.send(OutMessage{Type: "env_status", EnvID: env.id, Online: boolPtr(false), Error: "Docker not reachable"})
		}
		return
	}

	if !env.online || !env.statusReported {
		env.online = true
		env.statusReported = true
		m.send(OutMessage{Type: "env_status", EnvID: env.id, Online: boolPtr(true)})
	}

	now := time.Now().Unix()
	since := now - 30

	ctx, cancel := context.WithTimeout(env.ctx, 15*time.Second)
	defer cancel()

	resp, err := env.doRequest(ctx, "GET", fmt.Sprintf("/events?type=container&since=%d&until=%d", since, now))
	if err != nil {
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode/100 != 2 {
		io.Copy(io.Discard, resp.Body)
		return
	}

	pollScanner := bufio.NewScanner(resp.Body)
	pollScanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for pollScanner.Scan() {
		line := pollScanner.Bytes()
		if len(line) == 0 {
			continue
		}
		if json.Valid(line) {
			m.send(OutMessage{
				Type:  "container_event",
				EnvID: env.id,
				Event: json.RawMessage(append([]byte(nil), line...)),
			})
		}
	}
}

// ---------------------------------------------------------------------------
// Disk usage check goroutine
// ---------------------------------------------------------------------------

func (m *manager) runDiskChecks(env *environment) {
	if os.Getenv("SKIP_DF_COLLECTION") != "" {
		return
	}

	initDelay := time.NewTimer(10 * time.Second)
	select {
	case <-env.ctx.Done():
		if !initDelay.Stop() {
			<-initDelay.C
		}
		return
	case <-initDelay.C:
	}
	m.checkDisk(env)

	ticker := time.NewTicker(m.diskInterval)
	defer ticker.Stop()

	for {
		select {
		case <-env.ctx.Done():
			return
		case <-ticker.C:
			m.checkDisk(env)
		}
	}
}

func (m *manager) checkDisk(env *environment) {
	if !env.ping(env.ctx) {
		return
	}

	ctx, cancel := context.WithTimeout(env.ctx, 20*time.Second)
	defer cancel()

	resp, err := env.doRequest(ctx, "GET", "/system/df")
	if err != nil {
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode/100 != 2 {
		io.Copy(io.Discard, resp.Body)
		return
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, 10*1024*1024)) // 10MB cap
	if err != nil {
		return
	}

	// Also fetch /info for DriverStatus (percentage-based disk warnings)
	var infoBody json.RawMessage
	iCtx, iCancel := context.WithTimeout(env.ctx, 10*time.Second)
	defer iCancel()
	iResp, iErr := env.doRequest(iCtx, "GET", "/info")
	if iErr == nil {
		if iResp.StatusCode/100 == 2 {
			infoBody, _ = io.ReadAll(io.LimitReader(iResp.Body, 2*1024*1024)) // 2MB cap
		} else {
			io.Copy(io.Discard, iResp.Body)
		}
		iResp.Body.Close()
	}

	m.send(OutMessage{
		Type:  "disk_usage",
		EnvID: env.id,
		Data:  json.RawMessage(body),
		Info:  infoBody,
	})
}

// ---------------------------------------------------------------------------
// Environment lifecycle
// ---------------------------------------------------------------------------

func (m *manager) configure(msg InMessage) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if existing, ok := m.envs[msg.EnvID]; ok {
		existing.cancel()
		existing.closeTransports()
		delete(m.envs, msg.EnvID)
	}

	if msg.Config == nil {
		return
	}

	if msg.ConnectionType == "hawser-edge" {
		return
	}

	client, streamClient, transport, streamTransport, baseURL, err := buildClients(msg.Config)
	if err != nil {
		m.send(OutMessage{Type: "error", EnvID: msg.EnvID, Error: fmt.Sprintf("configure: %s", err)})
		return
	}

	ctx, cancel := context.WithCancel(context.Background())
	env := &environment{
		id:              msg.EnvID,
		name:            msg.Name,
		connectionType:  msg.ConnectionType,
		hawserToken:     msg.HawserToken,
		client:          client,
		streamClient:    streamClient,
		transport:       transport,
		streamTransport: streamTransport,
		baseURL:         baseURL,
		cancel:          cancel,
		ctx:             ctx,
	}

	m.envs[msg.EnvID] = env

	go m.runMetrics(env)
	go m.runEvents(env)
	go m.runDiskChecks(env)

	fmt.Fprintf(os.Stderr, "[collector] configured env %d (%s) type=%s base=%s\n", env.id, env.name, msg.ConnectionType, baseURL)
}

func (m *manager) remove(envID int) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if env, ok := m.envs[envID]; ok {
		env.cancel()
		env.closeTransports()
		delete(m.envs, envID)
		fmt.Fprintf(os.Stderr, "[collector] removed env %d\n", envID)
	}
}

func (m *manager) shutdown() {
	m.mu.Lock()
	defer m.mu.Unlock()

	for id, env := range m.envs {
		env.cancel()
		env.closeTransports()
		delete(m.envs, id)
	}
	fmt.Fprintf(os.Stderr, "[collector] shutdown complete\n")
}

func (m *manager) setMetricsInterval(ms int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if ms > 0 {
		m.metricsInterval = time.Duration(ms) * time.Millisecond
		fmt.Fprintf(os.Stderr, "[collector] metrics interval set to %dms\n", ms)
	}
}

func (m *manager) setEventMode(mode string, pollMs int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if mode != "" {
		m.eventMode = mode
	}
	if pollMs > 0 {
		m.pollInterval = time.Duration(pollMs) * time.Millisecond
	}
	fmt.Fprintf(os.Stderr, "[collector] event mode=%s pollInterval=%dms\n", m.eventMode, m.pollInterval/time.Millisecond)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

func main() {
	fmt.Fprintf(os.Stderr, "[collector] starting...\n")

	encoder := json.NewEncoder(os.Stdout)
	mgr := newManager(encoder)

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)

	go func() {
		<-sigCh
		fmt.Fprintf(os.Stderr, "[collector] received signal, shutting down\n")
		mgr.shutdown()
		os.Exit(0)
	}()

	mgr.send(OutMessage{Type: "ready"})

	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 0, 64*1024), 10*1024*1024) // 64KB initial, grows to 10MB if needed

	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}

		var msg InMessage
		if err := json.Unmarshal(line, &msg); err != nil {
			fmt.Fprintf(os.Stderr, "[collector] invalid message: %s\n", err)
			continue
		}

		switch msg.Type {
		case "configure":
			mgr.configure(msg)
		case "remove":
			mgr.remove(msg.EnvID)
		case "set_metrics_interval":
			mgr.setMetricsInterval(msg.IntervalMs)
		case "set_event_mode":
			mgr.setEventMode(msg.Mode, msg.PollIntervalMs)
		case "shutdown":
			mgr.shutdown()
			os.Exit(0)
		default:
			fmt.Fprintf(os.Stderr, "[collector] unknown message type: %s\n", msg.Type)
		}
	}

	// stdin closed — parent process exited or pipe broke. Shut down cleanly
	// so Node.js can restart us if needed.
	if err := scanner.Err(); err != nil {
		fmt.Fprintf(os.Stderr, "[collector] stdin read error: %v\n", err)
	}
	fmt.Fprintf(os.Stderr, "[collector] stdin closed, exiting\n")
	mgr.shutdown()
}

func minDuration(a, b time.Duration) time.Duration {
	if a < b {
		return a
	}
	return b
}
