# Q2: Keep sync and remove up

## Decision

Keep `dev ws sync` as an alias of `dev ws update` at the maintainer's request. Its distinct intent remains unclear; retaining the spelling does not decide a new behavior for it. Remove `dev ws up`. Recovery hints name `dev ws update`.

## Rejected alternative

Removing both aliases also removes `dev ws sync`, which the maintainer chooses to keep.
