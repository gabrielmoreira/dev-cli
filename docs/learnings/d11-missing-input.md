# D11: One contract for missing input

## Decision

A required value that is absent and cannot be prompted for returns `INTERACTION_REQUIRED` with exit 2 and a structured `usage`, in both the human and `--json` shapes, whether the value is a positional or a flag. Omitted values stay `undefined` until the workflow decides: explicit argument, then inference, then a prompt only where the session can prompt. Committed d7b884c.

## Rejected alternative

Letting citty's own required-argument error surface. It printed `Missing required positional argument: NAME` with exit 1, no usage and no remedy, and a flag-shaped omission produced a different message from a positional one.
