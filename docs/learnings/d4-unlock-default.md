# D4: Resolve an omitted unlock branch

## Decision

When you omit the unlock branch, use `git.resolveDefaultBranch`. It reads the repository HEAD inherited from the remote default. If HEAD does not resolve, it chooses an existing local head: `main`, then `master`, then the first head. Unlock checks that the resolved branch exists rather than inventing one. If no branch resolves, use the interaction callback to prompt in a TTY; elsewhere return `INTERACTION_REQUIRED` naming `[branch]`.

## Rejected alternative

An unconditional `main` fallback invents a branch that may not exist or be the remote default. Choosing a verified existing head is not that fallback.
