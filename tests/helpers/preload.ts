// Test preload, referenced by `[test] preload` in bunfig.toml.
//
// The current suite is pure unit tests that mock their own transport, so there
// is no global setup to do yet. This file exists so the path bunfig.toml points
// at resolves; without it `bun test` fails before collecting any test.
export {};
