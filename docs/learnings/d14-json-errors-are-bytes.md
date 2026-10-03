# D14: `--json` errors are parsed by a machine, not coloured

## Decision

In JSON mode `ui.error` writes the payload to `process.stderr` directly, without colour, because Bun's `console.error` wraps a string in ANSI escapes whenever a terminal or `FORCE_COLOR` says so. A regression test runs the CLI as a subprocess with `FORCE_COLOR=1` and parses stderr, and asserts no escape sequence is present. Committed fe8eae4.

## Rejected alternative

Stripping ANSI in tests. The consumer is a script, not the test; the bytes on stderr are the contract. Per-call-site `process.stderr.write` was rejected too: every error path goes through one renderer.
