# DX plan decisions

The decisions taken while executing `.local/plan-2026-10-02-dx/`, one section each, with the alternative that was rejected. Item 7.1 owns this record.

## D9: Global flags parse in any position

**Decision.** Read `--json`, `--quiet` and `--non-interactive` from citty's own boolean parsing for the whole argument vector, whether the flag precedes the command group or follows it, and accept the `--json=true`, `--json=false` and `--no-json` spellings through one parser. `src/cli/context.ts` sets the ambient output policy once (`ui.setQuiet`, `ui.setJson`), and `ui.isJson()` is what handlers and `reportError` read. Before the fix, `dev ws ls --json` printed JSON while `dev --json ws ls` printed text, so a script had to know where to put the flag. Committed 0b1e3da.

**Rejected alternative.** Grep the raw argv for `--json` before citty runs. That duplicates citty's parsing and disagrees with it on `--json=false` and `--no-json`; the first version of item 1.2 had exactly that bug, and the item's own test caught it.

## D10: Confirmation is not permission to discard work

**Decision.** `--yes` answers a confirmation; `--force` also permits discarding uncommitted changes, unpushed commits or an unmanaged checkout. A removal handler passes `args.yes || args.force` to the interaction and only `args.force` to the domain, so automating a prompt never widens what may be deleted. `--yes=false --force` still removes, because force implies confirmation. Committed 06501de.

**Rejected alternative.** Keeping `--force` as the only unattended confirmation: every script then accepts data loss to avoid a prompt, which is the mix this separates. A separate `--confirm` was rejected as a second name for the same idea.

## D11: One contract for missing input

**Decision.** A required value that is absent and cannot be prompted for returns `INTERACTION_REQUIRED` with exit 2 and a structured `usage`, in both the human and `--json` shapes, whether the value is a positional or a flag. Omitted values stay `undefined` until the workflow decides: explicit argument, then inference, then a prompt only where the session can prompt. Committed d7b884c.

**Rejected alternative.** Letting citty's own required-argument error surface. It printed `Missing required positional argument: NAME` with exit 1, no usage and no remedy, and a flag-shaped omission produced a different message from a positional one.

## D12: Every error code owns its exit status

**Decision.** `src/cli/errors.ts` maps every code the code base can throw to an exit status and a next step, and a unit test enumerates the codes literally and fails when a code is missing from either table. Relation to a refusal is explicit: `UNSAFE_REMOVE`, `UNMANAGED_CHECKOUT` and `DIRTY_WORKTREE` are 3; a source that matches nothing is 2. Committed 4e819bb.

**Rejected alternative.** Deriving the status from the error class name or from a prefix. Neither is checked by the compiler, and the survey found codes thrown from paths with no table entry at all.

## D13: One symbol per kind of outcome

**Decision.** `✓` a completed action, `○` a fact, already-applied state or a proposed plan, `⚠` a caveat, `✗` a failure, `↳` the next command, and `↻` progress on stderr only. A clean status is a fact, so it prints `○`; a dirty or behind mount is a caveat, `⚠`, without changing the successful exit. Committed e7d911f.

**Rejected alternative.** Reusing `✓` for a read command that reported clean state: it reads as an action that just happened, and the same output then means different things in a script's log.

## D14: `--json` errors are parsed by a machine, not coloured

**Decision.** In JSON mode `ui.error` writes the payload to `process.stderr` directly, without colour, because Bun's `console.error` wraps a string in ANSI escapes whenever a terminal or `FORCE_COLOR` says so. A regression test runs the CLI as a subprocess with `FORCE_COLOR=1` and parses stderr, and asserts no escape sequence is present. Committed fe8eae4.

**Rejected alternative.** Stripping ANSI in tests: the consumer is a script, not the test, and the bytes on stderr are the contract. Per-call-site `process.stderr.write` was rejected too, because every error path goes through one renderer.
