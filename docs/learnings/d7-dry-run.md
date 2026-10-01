# D7: Fetch before planning a dry run

## Decision

A workspace dry run fetches remote refs by default, skips admin healing, and returns the plan without changing worktrees or the manifest. The help text states that it fetches. Dry-run is not a promise of an offline preview.

## Rejected alternative

A fully offline preview can plan from stale refs and show a plan that no longer matches the remote.
