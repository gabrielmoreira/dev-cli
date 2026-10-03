# D12: Every error code owns its exit status

## Decision

`src/cli/errors.ts` maps every code the code base can throw to an exit status and a next step, and a unit test enumerates the codes literally and fails when a code is missing from either table. Relation to a refusal is explicit: `UNSAFE_REMOVE`, `UNMANAGED_CHECKOUT` and `DIRTY_WORKTREE` are 3; a source that matches nothing is 2. Committed 4e819bb.

## Rejected alternative

Deriving the status from the error class name or from a prefix. Neither is checked by the compiler, and the survey found codes thrown from paths with no table entry at all.
