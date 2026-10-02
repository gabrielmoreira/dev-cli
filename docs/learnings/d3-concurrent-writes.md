# D3: Lock manifest and configuration writes

## Decision

Use `fs.withFileLock` per manifest or configuration file around read-mutate-write. The lock directory contains an owner file with a PID and hostname. Reclaim a dead owner on the same host under a reclaim guard. Otherwise wait, then return `FILE_LOCKED` after 10 seconds with the lock directory named in the error. Do not break a lock based on its age. Route every `dev.yaml` edit through `config.updateConfig`. Keep Git side effects outside the lock.

Missing, unreadable, or other-host ownership is not evidence that a writer died. Those locks time out and require operator review; do not delete them automatically. PID reuse also keeps a lock held rather than risking a live writer.

The reclaim guard is a sibling directory (`<file>.lock.reclaim`), never an entry inside the lock. Creating it inside the lock raced the owner's recursive removal on Linux and left an empty, ownerless lock that every waiter then timed out on. The guard records its owner, but a guard left by a waiter that crashed mid-reclaim is never removed automatically: `FILE_LOCKED` names it in `details.reclaimPath` for the operator. Automatic takeover was tried in v4.0.2 and rejected: two waiters could both judge the same guard stale, and the slower one deleted the replacement guard; serializing the takeover needs yet another guard that can itself be stranded. The case needs two crashes in a row (the lock owner, then its reclaimer), and v4.0.0 stalled on it too.

## Contract

`fs.withFileLock<T>(targetPath, fn, options?: { timeoutMs?: number }): Promise<T>` allows callers to adjust how long they wait, not how old a lock may become. A timeout returns `FileLockError` with code `FILE_LOCKED` and details containing the target `path`, `lockPath`, `owner` (PID and hostname) when available, and `reclaimPath` when the reclaim guard was held at the last attempt, whether or not its owner file can be read. See [`src/fs.ts`](../../src/fs.ts) for the implementation.

## Rejected alternative

Age-based stale-lock removal can steal a live writer's lock when an operation takes longer than expected. A global lock around whole commands serializes clones and unrelated work. Re-reading immediately before writing narrows the lost-update window but does not close it.
