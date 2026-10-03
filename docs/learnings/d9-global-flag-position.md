# D9: Global flags parse in any position

## Decision

Read `--json`, `--quiet` and `--non-interactive` from citty's own boolean parsing for the whole argument vector, whether the flag precedes the command group or follows it, and accept the `--json=true`, `--json=false` and `--no-json` spellings through one parser. `src/cli/context.ts` sets the ambient output policy once (`ui.setQuiet`, `ui.setJson`), and `ui.isJson()` is what handlers and `reportError` read. Before the fix, `dev ws ls --json` printed JSON while `dev --json ws ls` printed text, so a script had to know where to put the flag. Committed 0b1e3da.

## Rejected alternative

Grep the raw argv for `--json` before citty runs. That duplicates citty's parsing and disagrees with it on `--json=false` and `--no-json`; the first version of this item had exactly that bug, and the item's own test caught it.
