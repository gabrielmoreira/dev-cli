# D3: Lock manifest and configuration writes

## Decision

Use `fs.withFileLock` per manifest or configuration file around read-mutate-write. The lock directory contains an owner file with a PID and hostname. Reclaim a dead owner on the same host under a reclaim guard. Otherwise wait, then return `FILE_LOCKED` after 10 seconds with the lock directory named in the error. Do not break a lock based on its age. Route every `dev.yaml` edit through `config.updateConfig`. Keep Git side effects outside the lock.

Missing, unreadable, or other-host ownership is not evidence that a writer died. Those locks time out and require operator review; do not delete them automatically. PID reuse also keeps a lock held rather than risking a live writer.

The reclaim guard is a sibling directory (`<file>.lock.reclaim`), never an entry inside the lock. Creating it inside the lock raced the owner's recursive removal on Linux and left an empty, ownerless lock that every waiter then timed out on.

## Contract

`fs.withFileLock<T>(targetPath, fn, options?: { timeoutMs?: number }): Promise<T>` allows callers to adjust how long they wait, not how old a lock may become. A timeout returns `FileLockError` with code `FILE_LOCKED` and details containing the target `path`, `lockPath`, and `owner` (PID and hostname) when available. See [`src/fs.ts`](../../src/fs.ts) for the implementation.

## Rejected alternative

Age-based stale-lock removal can steal a live writer's lock when an operation takes longer than expected. A global lock around whole commands serializes clones and unrelated work. Re-reading immediately before writing narrows the lost-update window but does not close it.
