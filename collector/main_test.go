package main

import (
	"encoding/json"
	"math"
	"testing"
)

// mustStats decodes a JSON stats payload into containerStats for the tests.
func mustStats(t *testing.T, jsonStr string) *containerStats {
	t.Helper()
	var s containerStats
	if err := json.Unmarshal([]byte(jsonStr), &s); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return &s
}

const unixPayload = `{
  "read": "2026-09-15T10:00:01Z",
  "preread": "2026-09-15T10:00:00Z",
  "cpu_stats": {"cpu_usage": {"total_usage": 2000000000}, "system_cpu_usage": 20000000000, "online_cpus": 4},
  "precpu_stats": {"cpu_usage": {"total_usage": 1000000000}, "system_cpu_usage": 18000000000},
  "memory_stats": {"usage": 209715200, "stats": {"inactive_file": 52428800}}
}`

// Windows: no system_cpu_usage, privateworkingset present, 1000ms elapsed, 2 procs.
const windowsPayload = `{
  "read": "2026-09-15T10:00:01.0000000Z",
  "preread": "2026-09-15T10:00:00.0000000Z",
  "num_procs": 2,
  "cpu_stats": {"cpu_usage": {"total_usage": 500000000}},
  "precpu_stats": {"cpu_usage": {"total_usage": 400000000}},
  "memory_stats": {"privateworkingset": 134217728}
}`

func closeTo(a, b float64) bool { return math.Abs(a-b) < 1e-6 }

func TestCalcCPUPercentUnix(t *testing.T) {
	// cpuDelta=1e9, sysDelta=2e9, cpuCount=4 -> 0.5*4*100 = 200
	got := calcCPUPercent(mustStats(t, unixPayload))
	if !closeTo(got, 200) {
		t.Fatalf("unix cpu: got %v want 200", got)
	}
}

func TestCalcCPUPercentWindows(t *testing.T) {
	// cpuDelta=1e8, elapsed=1000ms, num_procs=2 -> possIntervals=2000
	// cpu = cpuDelta / (possIntervals*100) = 1e8/(2000*100) = 500. Matches the TS core.
	got := calcCPUPercent(mustStats(t, windowsPayload))
	want := 1e8 / (2 * 1000 * 100)
	if !closeTo(got, want) {
		t.Fatalf("windows cpu: got %v want %v", got, want)
	}
	if !closeTo(got, 500) {
		t.Fatalf("windows cpu: got %v want 500", got)
	}
	if got <= 0 {
		t.Fatalf("windows cpu must be > 0 (proves the Windows branch ran, not the Unix 0)")
	}
}

func TestCalcCPUPercentWindowsZeroElapsed(t *testing.T) {
	s := mustStats(t, windowsPayload)
	s.Preread = s.Read // no elapsed time
	if got := calcCPUPercent(s); got != 0 {
		t.Fatalf("zero elapsed must be 0, got %v", got)
	}
}

func TestCalcMemUsageUnix(t *testing.T) {
	// 200MiB usage - 50MiB cache = 150MiB
	got := calcMemUsage(mustStats(t, unixPayload))
	if got != 150*1024*1024 {
		t.Fatalf("unix mem: got %d want %d", got, 150*1024*1024)
	}
}

func TestCalcMemUsageWindows(t *testing.T) {
	// privateworkingset used directly, no cache subtraction
	got := calcMemUsage(mustStats(t, windowsPayload))
	if got != 128*1024*1024 {
		t.Fatalf("windows mem: got %d want %d", got, 128*1024*1024)
	}
	if got == 0 {
		t.Fatalf("windows mem must not be 0 (the #1574 symptom)")
	}
}

func TestCalcCPUPercentCounterReset(t *testing.T) {
	// precpu > cpu (counter reset / first sample). uint64 subtraction would wrap to a
	// huge positive; the fix must return 0, not garbage. Both Unix and Windows branches.
	unixReset := mustStats(t, `{"cpu_stats":{"cpu_usage":{"total_usage":1000},"system_cpu_usage":5000,"online_cpus":2},"precpu_stats":{"cpu_usage":{"total_usage":2000},"system_cpu_usage":4000},"memory_stats":{"usage":1000}}`)
	if got := calcCPUPercent(unixReset); got != 0 {
		t.Fatalf("unix counter reset must be 0 (no uint64 underflow garbage), got %v", got)
	}
	winReset := mustStats(t, `{"read":"2026-09-15T10:00:01Z","preread":"2026-09-15T10:00:00Z","num_procs":2,"cpu_stats":{"cpu_usage":{"total_usage":1000}},"precpu_stats":{"cpu_usage":{"total_usage":2000}},"memory_stats":{"privateworkingset":1000}}`)
	if got := calcCPUPercent(winReset); got != 0 {
		t.Fatalf("windows counter reset must be 0, got %v", got)
	}
}

func TestCalcCPUPercentSystemCounterReset(t *testing.T) {
	// cpu increases but SYSTEM counter went backwards -> sysDelta underflow guard.
	s := mustStats(t, `{"cpu_stats":{"cpu_usage":{"total_usage":2000},"system_cpu_usage":4000,"online_cpus":2},"precpu_stats":{"cpu_usage":{"total_usage":1000},"system_cpu_usage":5000},"memory_stats":{"usage":1000}}`)
	if got := calcCPUPercent(s); got != 0 {
		t.Fatalf("system counter reset must be 0, got %v", got)
	}
}
