# D2: Refuse removal of unmanaged checkouts

## Decision

Remove a registered worktree through the workspace's admin repository. Do not fall back to recursive deletion when Git removal fails. Refuse an unregistered checkout with `UNMANAGED_CHECKOUT` unless you pass `--force`. When a branch has no upstream or matching remote branch, count commits reachable from `HEAD` but from no remote with `--not --remotes` before allowing removal.

## Rejected alternative

Keeping a recursive-delete fallback with more checks still deletes data after an unrecognized Git failure. Those checks do not establish checkout ownership.
