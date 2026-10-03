# D10: Confirmation is not permission to discard work

## Decision

`--yes` answers a confirmation; `--force` also permits discarding uncommitted changes, unpushed commits or an unmanaged checkout. A removal handler passes `args.yes || args.force` to the interaction and only `args.force` to the domain, so automating a prompt never widens what may be deleted. `--yes=false --force` still removes, because force implies confirmation. Committed 06501de.

## Rejected alternative

Keeping `--force` as the only unattended confirmation. Every script then accepts data loss to avoid a prompt, which is the mix this item separates. A separate `--confirm` was rejected as a second name for the same idea.
