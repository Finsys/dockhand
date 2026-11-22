package main

import (
	"encoding/json"
	"io"
	"math"
	"testing"
	"time"
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

func TestPollWindowStartContinuesFromTheLastWindow(t *testing.T) {
	last := time.Date(2026, 11, 16, 10, 0, 0, 500, time.UTC)
	now := last.Add(60 * time.Second)
	got := pollWindowStart(last, now, 60*time.Second)
	// One nanosecond on: Docker includes since and until, so the event at the
	// last window's end is not read twice.
	if want := last.Add(time.Nanosecond); !got.Equal(want) {
		t.Fatalf("since = %v, want %v", got, want)
	}
}

func TestPollWindowStartCoversALongIntervalWhole(t *testing.T) {
	// The bug: every poll read the last 30 seconds whatever the interval, so a
	// 5-minute interval missed four and a half minutes of every five.
	last := time.Date(2026, 11, 16, 10, 0, 0, 0, time.UTC)
	now := last.Add(5 * time.Minute)
	if got := pollWindowStart(last, now, 5*time.Minute); now.Sub(got) < 5*time.Minute-time.Nanosecond {
		t.Fatalf("window starts %v before now, want the whole interval", now.Sub(got))
	}
}

func TestPollWindowStartFirstPollReadsAtMostThirtySeconds(t *testing.T) {
	// A fresh collector (a restart) must not send again what was recorded just
	// before it, so the first window is the shorter of the interval and 30s.
	now := time.Date(2026, 11, 16, 10, 0, 0, 0, time.UTC)
	if got := pollWindowStart(time.Time{}, now, 5*time.Minute); !got.Equal(now.Add(-firstPollLookBack)) {
		t.Fatalf("since = %v, want %v back", now.Sub(got), firstPollLookBack)
	}
	if got := pollWindowStart(time.Time{}, now, 20*time.Second); !got.Equal(now.Add(-20 * time.Second)) {
		t.Fatalf("since = %v, want the shorter interval back", now.Sub(got))
	}
}

func TestPollWindowStartDoesNotReplayALongOutage(t *testing.T) {
	last := time.Date(2026, 11, 16, 10, 0, 0, 0, time.UTC)
	now := last.Add(maxPollCatchUp + time.Second)
	if got := pollWindowStart(last, now, 60*time.Second); !got.Equal(now.Add(-firstPollLookBack)) {
		t.Fatalf("since = %v, want a fresh window after a long gap", got)
	}
}

func TestPollWindowStartCatchesUpAShortOutage(t *testing.T) {
	// A missed poll or two: the next one reads everything since the last window.
	last := time.Date(2026, 11, 16, 10, 0, 0, 0, time.UTC)
	now := last.Add(3 * time.Minute)
	if got := pollWindowStart(last, now, 60*time.Second); !got.Equal(last.Add(time.Nanosecond)) {
		t.Fatalf("since = %v, want just after the last window", got)
	}
}

func TestDockerTimestamp(t *testing.T) {
	ts := time.Unix(1794832642, 5).UTC()
	if got := dockerTimestamp(ts); got != "1794832642.000000005" {
		t.Fatalf("dockerTimestamp = %q", got)
	}
}

func TestPollUntilSurvivesReconfigureAndIsDroppedOnRemove(t *testing.T) {
	// configure() rebuilds every environment whenever any one changes; the window end
	// must outlive that, or the next poll replays what was already sent.
	m := newManager(json.NewEncoder(io.Discard))
	// Poll mode: in stream mode the started goroutine rightly drops the entry. Here it
	// fails to reach the socket and records nothing.
	m.eventMode = "poll"
	cfg := InMessage{Type: "configure", EnvID: 7, Name: "t", ConnectionType: "socket",
		Config: &EnvConfig{Type: "socket", SocketPath: "/nonexistent/docker.sock"}}
	m.configure(cfg)
	until := time.Date(2026, 11, 16, 10, 0, 0, 0, time.UTC)
	m.recordPollEnd(7, until)
	m.configure(cfg)
	m.mu.Lock()
	got := m.pollUntil[7]
	m.mu.Unlock()
	if !got.Equal(until) {
		t.Fatalf("pollUntil = %v after reconfigure, want %v", got, until)
	}
	m.remove(7)
	m.mu.Lock()
	_, kept := m.pollUntil[7]
	m.mu.Unlock()
	if kept {
		t.Fatal("pollUntil kept for a removed environment")
	}
}

func TestRecordPollEndOnlyMovesForwardAndOnlyForAKnownEnvironment(t *testing.T) {
	m := newManager(json.NewEncoder(io.Discard))
	m.envs[3] = &environment{id: 3, cancel: func() {}}
	later := time.Date(2026, 11, 16, 10, 5, 0, 0, time.UTC)
	m.recordPollEnd(3, later)
	m.recordPollEnd(3, later.Add(-time.Minute)) // a late, cancelled goroutine
	if got := m.pollUntil[3]; !got.Equal(later) {
		t.Fatalf("pollUntil moved back to %v", got)
	}
	m.recordPollEnd(3, time.Time{})
	if got := m.pollUntil[3]; !got.Equal(later) {
		t.Fatalf("a zero end replaced %v", got)
	}
	m.recordPollEnd(4, later) // removed or never configured
	if _, ok := m.pollUntil[4]; ok {
		t.Fatal("an end was recorded for an unknown environment")
	}
}
