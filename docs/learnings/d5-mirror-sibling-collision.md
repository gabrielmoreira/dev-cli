# D5: Preserve mirror sibling paths and reject collisions

## Decision

Keep existing sibling checkout paths. Before reuse, track, untrack, or ensure uses an existing sibling, read its actual branch. If it differs from the requested branch, return `MIRROR_PATH_COLLISION` with both branches. The known limit is that names such as `feature/a` and `feature-a` cannot both be tracked as siblings. The second is refused.

## Rejected alternative

Hashing every sibling path requires moving existing checkouts to address the collision. Keep the paths and refuse the conflicting branch instead.
