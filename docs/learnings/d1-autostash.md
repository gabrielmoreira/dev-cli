# D1: Keep autostash ownership exact

## Decision

Stash only a dirty worktree through `git.stashWorktree`, which refuses an empty stash and verifies the new SHA. Restore with `git stash apply <sha>` after the fast-forward, or attempt restoration when the fast-forward fails. Never drop the entry. It stays as your backup, and the result reports its name, SHA, and `git stash apply <sha>` even after a clean apply. An apply conflict returns `STASH_RESTORE_FAILED` with the backup and recovery details.

## Rejected alternative

`git stash pop` applies and drops `stash@{0}`, which may be your stash rather than the one this operation creates. Dropping the operation's entry after a clean apply requires `stash@{n}`. That index can shift between listing and dropping when you stash in another terminal, deleting the wrong entry.
