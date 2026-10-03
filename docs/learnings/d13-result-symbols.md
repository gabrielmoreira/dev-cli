# D13: One symbol per kind of outcome

## Decision

`✓` a completed action, `○` a fact, already-applied state or a proposed plan, `⚠` a caveat, `✗` a failure, `↳` the next command, and `↻` progress on stderr only. A clean status is a fact, so it prints `○`; a dirty or behind mount is a caveat, `⚠`, without changing the successful exit. Committed e7d911f.

## Rejected alternative

Reusing `✓` for a read command that reported clean state. It reads as an action that just happened, and the same output then means different things in a script's log.
