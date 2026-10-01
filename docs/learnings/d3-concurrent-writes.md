# D3: Lock manifest and configuration writes

## Decision

Use `fs.withFileLock` per manifest or configuration file around read-mutate-write. The lock directory contains an owner file with a PID and hostname. Reclaim a dead owner on the same host under a reclaim guard. Otherwise wait, then return `FILE_LOCKED` after 10 seconds with the lock directory named in the error. Do not break a lock based on its age. Route every `dev.yaml` edit through `config.updateConfig`. Keep Git side effects outside the lock.

## Rejected alternative

Age-based stale-lock removal can steal a live writer's lock when an operation takes longer than expected. A global lock around whole commands serializes clones and unrelated work. Re-reading immediately before writing narrows the lost-update window but does not close it.
