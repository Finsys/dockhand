// Test preload, referenced by `[test] preload` in bunfig.toml.
//
// This file exists so the path bunfig.toml points at resolves; without it
// `bun test` fails before collecting any test.

/**
 * Bun test preload — runs before every test file (see bunfig.toml).
 * Integration tests create many environments on the same Docker daemon; skip
 * duplicate-env validation unless a test explicitly clears this flag.
 */
process.env.DOCKHAND_ALLOW_DUPLICATE_ENVS ??= '1';
